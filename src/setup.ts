import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { InternSession } from "./api.js";
import { PACKAGE_VERSION, type InternConfig } from "./config.js";

const exec = promisify(execFile);
const defaultPackage = `@archastro/intern-mcp@${PACKAGE_VERSION}`;

export type SetupHost = "codex" | "claude";

interface CommandResult {
  status: number;
  stdout: string;
}

interface FileSnapshot {
  contents: Buffer;
  mode: number;
}

interface ClaudeEntrySnapshot {
  exists: boolean;
  value?: unknown;
}

interface SetupDependencies {
  token?: string;
  packageSpec?: string;
  promptToken?: () => Promise<string>;
  session?: (token: string) => Promise<InternSession>;
  run?: (command: string, args: string[]) => Promise<CommandResult>;
  write?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  verbose?: boolean;
}

class HostConfigurationCommittedError extends Error {}

export function parseSetupOptions(args: string[]): {
  host: SetupHost;
  verbose: boolean;
} {
  let host: SetupHost | undefined;
  let verbose = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--verbose") {
      verbose = true;
      continue;
    }
    const hostValue = value.startsWith("--host=")
      ? value.slice("--host=".length)
      : value === "--host"
        ? args[++index]
        : undefined;
    if (
      hostValue === undefined ||
      host !== undefined ||
      (hostValue !== "codex" && hostValue !== "claude")
    ) {
      throw new Error(setupUsage());
    }
    host = hostValue;
  }
  if (!host) throw new Error(setupUsage());
  return { host, verbose };
}

export async function runSetup(
  config: InternConfig,
  host: SetupHost,
  dependencies: SetupDependencies = {},
): Promise<InternSession> {
  const promptToken = dependencies.promptToken ?? promptAccessToken;
  const env = dependencies.env ?? process.env;
  const verbose = dependencies.verbose ?? false;
  const token = (
    dependencies.token ??
    env.INTERN_ACCESS_TOKEN ??
    (await promptToken())
  ).trim();
  if (!token) throw new Error("An Intern access token is required");

  const session = dependencies.session
    ? await dependencies.session(token)
    : await verifyMcp(token, env, verbose);
  const run = dependencies.run ?? runCommand;
  const packageSpec =
    dependencies.packageSpec ?? env.INTERN_MCP_PACKAGE ?? defaultPackage;
  const releaseLock = await acquireSetupLock(config.configRoot);
  try {
    const tokenFile = accessTokenFile(config);
    const previousToken = await snapshotFile(tokenFile);
    await writeAccessToken(config, token);
    try {
      await configureHost(host, packageSpec, env, run);
    } catch (error) {
      if (!(error instanceof HostConfigurationCommittedError)) {
        await restoreFile(tokenFile, previousToken);
      }
      throw error;
    }

    const write =
      dependencies.write ?? ((message: string) => process.stdout.write(message));
    const hostName = host === "codex" ? "Codex" : "Claude Code";
    write(
      `Intern connected to ${hostName} as ${session.user.org_name} · ${session.user.org_role}.\nRestart ${hostName}, then ask it to run intern_auth_status.\n`,
    );
    return session;
  } finally {
    await releaseLock();
  }
}

async function configureHost(
  host: SetupHost,
  packageSpec: string,
  env: NodeJS.ProcessEnv,
  run: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<void> {
  const launcher = ["npx", "--yes", `--package=${packageSpec}`, "intern-mcp", "launch"];
  const environmentArgs = [
    "INTERN_BASE_URL",
    "INTERN_WORKSPACE_ROOT",
    "INTERN_CONFIG_ROOT",
    "INTERN_GIT_SSH_COMMAND",
  ].flatMap((name) => (env[name] ? ["--env", `${name}=${env[name]}`] : []));

  if (host === "codex") {
    const added = await run("codex", [
      "mcp",
      "add",
      "intern",
      ...environmentArgs,
      "--",
      ...launcher,
    ]);
    if (added.status !== 0) throw new Error("Could not configure Codex");
    const verified = await run("codex", ["mcp", "get", "intern", "--json"]);
    const healthy =
      verified.status === 0 &&
      verified.stdout.includes('"command": "npx"') &&
      verified.stdout.includes('"launch"');
    if (!healthy) {
      throw new HostConfigurationCommittedError(
        "Codex saved Intern but could not verify its registration; the new profile was retained",
      );
    }
    return;
  }

  const configFile = claudeConfigFile(env);
  const previousEntry = await readClaudeEntry(configFile);
  let installedEntry: ClaudeEntrySnapshot | undefined;
  try {
    await run("claude", ["mcp", "remove", "--scope", "user", "intern"]);
    const added = await run("claude", [
      "mcp",
      "add",
      "--transport",
      "stdio",
      "--scope",
      "user",
      "intern",
      ...environmentArgs,
      "--",
      ...launcher,
    ]);
    if (added.status !== 0) throw new Error("Could not configure Claude Code");
    installedEntry = await readClaudeEntry(configFile);

    const verified = await run("claude", ["mcp", "get", "intern"]);
    const output = stripANSI(verified.stdout);
    const healthy =
      verified.status === 0 &&
      /^\s*Scope:\s*User config(?:\s+\([^\n]*\))?\s*$/m.test(output) &&
      /^\s*Status:\s*.*Connected\s*$/m.test(output) &&
      !/^\s*Status:\s*.*Failed to connect\s*$/m.test(output) &&
      /^\s*Command:\s*npx\s*$/m.test(output) &&
      /^\s*Args:\s*.*\bintern-mcp\b.*\blaunch\b.*$/m.test(output);
    if (!healthy) {
      throw new Error(
        "Claude Code did not select the user-level Intern launcher; remove any local/project intern entry and run setup again",
      );
    }
  } catch (error) {
    await restoreClaudeEntry(configFile, previousEntry, installedEntry);
    throw error;
  }
}

async function verifyMcp(
  token: string,
  env: NodeJS.ProcessEnv,
  verbose: boolean,
): Promise<InternSession> {
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "serve"],
    env: {
      ...process.env,
      ...env,
      INTERN_ACCESS_TOKEN: token,
      ...(verbose ? { INTERN_MCP_VERBOSE: "1" } : {}),
    },
    stderr: verbose ? "inherit" : "pipe",
  });
  const client = new Client({ name: "intern-setup", version: PACKAGE_VERSION });
  await client.connect(transport);
  try {
    const response = await client.callTool({
      name: "intern_auth_status",
      arguments: {},
    });
    const result = response.structuredContent as
      | { authorized?: boolean; session?: InternSession }
      | undefined;
    if (result?.authorized !== true || !result.session) {
      throw new Error("Intern rejected this access token");
    }
    return result.session;
  } finally {
    await client.close();
  }
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await exec(command, args, {
      env: process.env,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { status: 0, stdout: result.stdout };
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "code" in error
        ? Number(error.code) || 1
        : 1;
    return { status, stdout: "" };
  }
}

export async function promptAccessToken(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  const prompt = "Paste Intern access token: ";
  const hiddenOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const terminal = Boolean((input as { isTTY?: boolean }).isTTY);
  const lines = createInterface({
    input,
    output: terminal ? output : hiddenOutput,
    terminal,
  });
  if (terminal) installMaskedOutput(lines, output, prompt);
  output.write(prompt);
  try {
    const token = await question(lines);
    if (!terminal) output.write("\n");
    return token;
  } finally {
    lines.close();
  }
}

function installMaskedOutput(
  lines: Interface,
  output: NodeJS.WritableStream,
  prompt: string,
): void {
  const masked = lines as Interface & {
    line: string;
    _writeToOutput(value: string): void;
  };
  masked._writeToOutput = (value: string) => {
    if (value.includes("\n")) {
      output.write(value);
      return;
    }
    if (!value) return;
    output.write(
      `\r${String.fromCharCode(27)}[2K${prompt}${"*".repeat(Array.from(masked.line).length)}`,
    );
  };
}

function question(lines: Interface): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      lines.removeListener("SIGINT", cancel);
      lines.removeListener("close", cancel);
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Token entry cancelled"));
    };
    lines.once("SIGINT", cancel);
    lines.once("close", cancel);
    lines.question("", (answer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(answer);
    });
  });
}

function setupUsage(): string {
  return "Usage: intern-mcp setup --host codex|claude [--verbose]";
}

export async function readStoredAccessToken(config: InternConfig): Promise<string> {
  const token = (await fs.readFile(accessTokenFile(config), "utf8")).trim();
  if (!token) throw new Error("Intern access token profile is empty; run setup again");
  return token;
}

async function writeAccessToken(config: InternConfig, token: string): Promise<void> {
  await fs.mkdir(config.configRoot, { recursive: true, mode: 0o700 });
  const file = accessTokenFile(config);
  const temporary = path.join(
    config.configRoot,
    `.access-token.${process.pid}.${Date.now()}`,
  );
  await fs.writeFile(temporary, `${token}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}

function accessTokenFile(config: InternConfig): string {
  return path.join(config.configRoot, "access-token");
}

function claudeConfigFile(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? os.homedir();
  return path.join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json");
}

async function readClaudeEntry(file: string): Promise<ClaudeEntrySnapshot> {
  try {
    const document = JSON.parse(await fs.readFile(file, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    if (!Object.hasOwn(document.mcpServers ?? {}, "intern")) return { exists: false };
    return { exists: true, value: structuredClone(document.mcpServers!.intern) };
  } catch (error) {
    if (isMissing(error)) return { exists: false };
    throw error;
  }
}

async function restoreClaudeEntry(
  file: string,
  previous: ClaudeEntrySnapshot,
  installed: ClaudeEntrySnapshot | undefined,
): Promise<void> {
  let document: { mcpServers?: Record<string, unknown>; [key: string]: unknown };
  let mode = 0o600;
  try {
    const [contents, stat] = await Promise.all([
      fs.readFile(file, "utf8"),
      fs.stat(file),
    ]);
    document = JSON.parse(contents) as typeof document;
    mode = stat.mode & 0o777;
  } catch (error) {
    if (!isMissing(error)) throw error;
    document = {};
  }
  const servers = (document.mcpServers ??= {});
  const currentExists = Object.hasOwn(servers, "intern");
  const current = currentExists ? servers.intern : undefined;
  if (
    !installed &&
    currentExists === previous.exists &&
    (!currentExists || JSON.stringify(current) === JSON.stringify(previous.value))
  ) {
    return;
  }
  if (
    installed &&
    (currentExists !== installed.exists ||
      (currentExists && JSON.stringify(current) !== JSON.stringify(installed.value)))
  ) {
    throw new Error(
      "Claude Code's Intern configuration changed during setup; refusing to overwrite it",
    );
  }
  if (!installed && currentExists) {
    throw new Error(
      "Claude Code's Intern configuration changed during setup; refusing to overwrite it",
    );
  }
  if (previous.exists) servers.intern = previous.value;
  else delete servers.intern;
  await writeJSONAtomically(file, document, mode);
}

async function writeJSONAtomically(
  file: string,
  value: object,
  mode: number,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.intern-setup-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fs.rename(temporary, file);
  await fs.chmod(file, mode);
}

async function acquireSetupLock(configRoot: string): Promise<() => Promise<void>> {
  await fs.mkdir(configRoot, { recursive: true, mode: 0o700 });
  const lockFile = path.join(configRoot, "setup.lock");
  try {
    const handle = await fs.open(lockFile, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    return async () => {
      await handle.close();
      await fs.rm(lockFile, { force: true });
    };
  } catch (error) {
    if (!isExists(error)) throw error;
    const owner = Number.parseInt(
      await fs.readFile(lockFile, "utf8").catch(() => ""),
      10,
    );
    if (owner > 0 && processIsAlive(owner)) {
      throw new Error("Another Intern setup is already running");
    }
    throw new Error(
      `A stale Intern setup lock exists at ${lockFile}; remove it and retry`,
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function snapshotFile(file: string): Promise<FileSnapshot | null> {
  try {
    const [contents, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
    return { contents, mode: stat.mode & 0o777 };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function restoreFile(file: string, snapshot: FileSnapshot | null): Promise<void> {
  if (!snapshot) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.intern-setup-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, snapshot.contents, { mode: snapshot.mode });
  await fs.rename(temporary, file);
  await fs.chmod(file, snapshot.mode);
}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function isExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function stripANSI(value: string): string {
  const colorSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return value.replace(colorSequence, "");
}
