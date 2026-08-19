import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SETUP_HOSTS = [
  "codex",
  "claude",
  "grok",
  "cursor",
  "opencode",
  "rovodev",
  "pi",
] as const;

export type SetupHost = (typeof SETUP_HOSTS)[number];

export const HOST_DISPLAY_NAME: Record<SetupHost, string> = {
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok",
  cursor: "Cursor CLI",
  opencode: "OpenCode",
  rovodev: "Rovo Dev",
  pi: "Pi",
};

export function isSetupHost(value: string): value is SetupHost {
  return (SETUP_HOSTS as readonly string[]).includes(value);
}

export interface CommandResult {
  status: number;
  stdout: string;
}

export class HostConfigurationCommittedError extends Error {}

interface ClaudeEntrySnapshot {
  exists: boolean;
  value?: unknown;
}

interface FileSnapshot {
  contents: Buffer;
  mode: number;
}

const INTERN_ENV_KEYS = [
  "INTERN_BASE_URL",
  "INTERN_WORKSPACE_ROOT",
  "INTERN_CONFIG_ROOT",
  "INTERN_GIT_SSH_COMMAND",
] as const;

export async function configureHost(
  host: SetupHost,
  packageSpec: string,
  registry: string | undefined,
  env: NodeJS.ProcessEnv,
  run: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<string | undefined> {
  const launcher = internLauncher(packageSpec, registry);
  const savedEnv = internEnv(env);

  if (host === "codex") {
    await configureCliHost({
      name: "Codex",
      add: [
        "codex",
        "mcp",
        "add",
        "intern",
        ...codexEnvArgs(savedEnv),
        "--",
        ...launcher,
      ],
      verify: ["codex", "mcp", "get", "intern", "--json"],
      healthy: (stdout) =>
        stdout.includes('"command": "npx"') && stdout.includes('"launch"'),
      committed:
        "Codex saved Intern but could not verify its registration; the new profile was retained",
      run,
    });
    return;
  }

  if (host === "claude") {
    await configureClaude(launcher, savedEnv, env, run);
    return;
  }

  if (host === "grok") {
    await configureCliHost({
      name: "Grok",
      add: [
        "grok",
        "mcp",
        "add",
        "intern",
        "-s",
        "user",
        ...grokEnvArgs(savedEnv),
        "--",
        ...launcher,
      ],
      verify: ["grok", "mcp", "list", "--json"],
      healthy: (stdout) =>
        stdout.includes("intern") &&
        stdout.includes("npx") &&
        stdout.includes("launch"),
      committed:
        "Grok saved Intern but could not verify its registration; the new profile was retained",
      run,
    });
    return;
  }

  if (host === "cursor") {
    await upsertMcpServersFile(
      cursorConfigFile(env),
      stdioServer(launcher, savedEnv, { type: "stdio" }),
      (intern) => commandIsNpx(intern) && argsIncludeLaunch(intern),
    );
    return;
  }

  if (host === "opencode") {
    await upsertOpenCode(openCodeConfigFile(env), launcher, savedEnv);
    return;
  }

  if (host === "rovodev") {
    await upsertMcpServersFile(
      rovoConfigFile(env),
      stdioServer(launcher, savedEnv, { transport: "stdio" }),
      (intern) => commandIsNpx(intern) && argsIncludeLaunch(intern),
    );
    return;
  }

  await upsertMcpServersFile(
    piConfigFile(env),
    stdioServer(launcher, savedEnv),
    (intern) => commandIsNpx(intern) && argsIncludeLaunch(intern),
  );
  return "Pi does not load MCP until you install the adapter: pi install npm:pi-mcp-adapter\nThen restart Pi.\n";
}

function internLauncher(packageSpec: string, registry: string | undefined): string[] {
  return [
    "npx",
    "--yes",
    "--prefer-online",
    ...(registry ? [`--@archastro:registry=${registry}`] : []),
    `--package=${packageSpec}`,
    "intern-mcp",
    "launch",
  ];
}

function internEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const saved: Record<string, string> = {};
  for (const name of INTERN_ENV_KEYS) {
    const value = env[name];
    if (value) saved[name] = value;
  }
  return saved;
}

function codexEnvArgs(saved: Record<string, string>): string[] {
  return Object.entries(saved).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
}

function grokEnvArgs(saved: Record<string, string>): string[] {
  return Object.entries(saved).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}

function stdioServer(
  launcher: string[],
  savedEnv: Record<string, string>,
  extra: Record<string, string> = {},
): Record<string, unknown> {
  return {
    ...extra,
    command: launcher[0],
    args: launcher.slice(1),
    ...(Object.keys(savedEnv).length > 0 ? { env: savedEnv } : {}),
  };
}

async function configureCliHost(options: {
  name: string;
  add: string[];
  verify: string[];
  healthy: (stdout: string) => boolean;
  committed: string;
  run: (command: string, args: string[]) => Promise<CommandResult>;
}): Promise<void> {
  const added = await options.run(options.add[0]!, options.add.slice(1));
  if (added.status !== 0) throw new Error(`Could not configure ${options.name}`);
  const verified = await options.run(options.verify[0]!, options.verify.slice(1));
  if (verified.status !== 0 || !options.healthy(verified.stdout)) {
    throw new HostConfigurationCommittedError(options.committed);
  }
}

async function configureClaude(
  launcher: string[],
  savedEnv: Record<string, string>,
  env: NodeJS.ProcessEnv,
  run: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<void> {
  const environmentArgs = Object.entries(savedEnv).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
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

async function upsertOpenCode(
  file: string,
  launcher: string[],
  savedEnv: Record<string, string>,
): Promise<void> {
  const intern = {
    type: "local",
    command: launcher,
    enabled: true,
    ...(Object.keys(savedEnv).length > 0 ? { environment: savedEnv } : {}),
  };
  const snapshot = await snapshotFile(file);
  try {
    const document = await readJsonObject(file);
    const mcp = jsonObject(document.mcp ?? {}, "mcp");
    document.mcp = mcp;
    mcp.intern = intern;
    await writeJSONAtomically(file, document, snapshot?.mode ?? 0o600);
    const written = jsonObject(
      jsonObject((await readJsonObject(file)).mcp, "mcp").intern,
      "intern",
    );
    const command = written.command;
    if (
      !Array.isArray(command) ||
      !command.includes("npx") ||
      !command.includes("intern-mcp") ||
      !command.includes("launch")
    ) {
      throw new Error("OpenCode Intern launcher was not saved");
    }
  } catch (error) {
    await restoreFile(file, snapshot);
    throw error;
  }
}

async function upsertMcpServersFile(
  file: string,
  intern: Record<string, unknown>,
  healthy: (intern: Record<string, unknown>) => boolean,
): Promise<void> {
  const snapshot = await snapshotFile(file);
  try {
    const document = await readJsonObject(file);
    const servers = jsonObject(document.mcpServers ?? {}, "mcpServers");
    document.mcpServers = servers;
    servers.intern = intern;
    await writeJSONAtomically(file, document, snapshot?.mode ?? 0o600);
    const written = jsonObject(
      jsonObject((await readJsonObject(file)).mcpServers, "mcpServers").intern,
      "intern",
    );
    if (!healthy(written)) {
      throw new Error(`Intern launcher was not saved in ${file}`);
    }
  } catch (error) {
    await restoreFile(file, snapshot);
    throw error;
  }
}

function commandIsNpx(intern: Record<string, unknown>): boolean {
  return intern.command === "npx";
}

function argsIncludeLaunch(intern: Record<string, unknown>): boolean {
  return (
    Array.isArray(intern.args) &&
    intern.args.includes("intern-mcp") &&
    intern.args.includes("launch")
  );
}

function cursorConfigFile(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME ?? os.homedir(), ".cursor", "mcp.json");
}

function openCodeConfigFile(env: NodeJS.ProcessEnv): string {
  return path.join(configHome(env), "opencode", "opencode.json");
}

function rovoConfigFile(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME ?? os.homedir(), ".rovodev", "mcp.json");
}

function piConfigFile(env: NodeJS.ProcessEnv): string {
  return path.join(configHome(env), "mcp", "mcp.json");
}

function claudeConfigFile(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? os.homedir();
  return path.join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json");
}

function configHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? os.homedir(), ".config");
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return jsonObject(parsed, file);
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function stripANSI(value: string): string {
  const colorSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return value.replace(colorSequence, "");
}
