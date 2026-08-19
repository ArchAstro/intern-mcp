import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { InternSession } from "./api.js";
import { PACKAGE_VERSION, type InternConfig } from "./config.js";
import {
  configureHost,
  HOST_DISPLAY_NAME,
  HostConfigurationCommittedError,
  isSetupHost,
  SETUP_HOSTS,
  type CommandResult,
  type SetupHost,
} from "./setup-hosts.js";

export type { SetupHost } from "./setup-hosts.js";
export { SETUP_HOSTS } from "./setup-hosts.js";

const exec = promisify(execFile);
const defaultPackage = "@archastro/intern-mcp@latest";

interface FileSnapshot {
  contents: Buffer;
  mode: number;
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
  registry?: string;
}

export function parseSetupOptions(args: string[]): {
  host: SetupHost;
  verbose: boolean;
  registry?: string;
} {
  let host: SetupHost | undefined;
  let verbose = false;
  let registry: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--verbose") {
      verbose = true;
      continue;
    }
    if (value === "--registry" || value.startsWith("--registry=")) {
      if (registry !== undefined) throw new Error(setupUsage());
      const registryValue = value.startsWith("--registry=")
        ? value.slice("--registry=".length)
        : args[++index];
      registry = parseRegistry(registryValue);
      continue;
    }
    const hostValue = value.startsWith("--host=")
      ? value.slice("--host=".length)
      : value === "--host"
        ? args[++index]
        : undefined;
    if (hostValue === undefined || host !== undefined || !isSetupHost(hostValue)) {
      throw new Error(setupUsage());
    }
    host = hostValue;
  }
  if (!host) throw new Error(setupUsage());
  return { host, verbose, ...(registry ? { registry } : {}) };
}

export async function runSetup(
  config: InternConfig,
  host: SetupHost,
  dependencies: SetupDependencies = {},
): Promise<InternSession> {
  const promptToken = dependencies.promptToken ?? promptAccessToken;
  const env = dependencies.env ?? process.env;
  const verbose = dependencies.verbose ?? false;
  const registry = dependencies.registry;
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
      const extra = await configureHost(host, packageSpec, registry, env, run);
      const write =
        dependencies.write ?? ((message: string) => process.stdout.write(message));
      const hostName = HOST_DISPLAY_NAME[host];
      write(
        `Intern connected to ${hostName} as ${session.user.org_name} · ${session.user.org_role}.\nRestart ${hostName}, then ask it to run intern_auth_status.\n`,
      );
      if (extra) write(extra);
    } catch (error) {
      if (!(error instanceof HostConfigurationCommittedError)) {
        await restoreFile(tokenFile, previousToken);
      }
      throw error;
    }
    return session;
  } finally {
    await releaseLock();
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
  output.write(prompt);
  const terminal = Boolean((input as { isTTY?: boolean }).isTTY);
  const raw =
    terminal &&
    "setRawMode" in input &&
    typeof (input as NodeJS.ReadStream).setRawMode === "function";
  if (raw) (input as NodeJS.ReadStream).setRawMode(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const paint = () => {
      if (!terminal) return;
      output.write(
        `\r${String.fromCharCode(27)}[2K${prompt}${"*".repeat(Array.from(buffer).length)}`,
      );
    };

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      if (raw) (input as NodeJS.ReadStream).setRawMode(false);
      action();
    };

    const onEnd = () => {
      finish(() => {
        if (!terminal) output.write("\n");
        resolve(buffer.replace(/\r?\n$/, ""));
      });
    };

    const onError = (error: Error) => {
      finish(() => reject(error));
    };

    const onData = (chunk: Buffer | string) => {
      const text = stripPasteBrackets(chunk.toString("utf8"));
      for (const char of text) {
        if (char === "\u0003") {
          finish(() => reject(new Error("Token entry cancelled")));
          return;
        }
        if (char === "\n" || char === "\r") {
          paint();
          finish(() => {
            output.write("\n");
            resolve(buffer);
          });
          return;
        }
        if (char === "\u007f" || char === "\b") {
          buffer = Array.from(buffer).slice(0, -1).join("");
          paint();
          continue;
        }
        if (char === "\u0015") {
          buffer = "";
          paint();
          continue;
        }
        if (char >= " " || char === "\t") {
          buffer += char;
          paint();
        }
      }
      paint();
    };

    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

function stripPasteBrackets(value: string): string {
  const escape = String.fromCharCode(27);
  return value.split(`${escape}[200~`).join("").split(`${escape}[201~`).join("");
}

function setupUsage(): string {
  return `Usage: intern-mcp setup --host ${SETUP_HOSTS.join("|")} [--verbose] [--registry URL]`;
}

function parseRegistry(value: string | undefined): string {
  try {
    const registry = new URL(value ?? "");
    if (
      registry.protocol !== "https:" ||
      registry.username ||
      registry.password ||
      registry.search ||
      registry.hash
    ) {
      throw new Error("unsafe registry");
    }
    return registry.toString().replace(/\/$/, "");
  } catch {
    throw new Error(setupUsage());
  }
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
