import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { InternSession } from "./api.js";
import { InternAPI } from "./api.js";
import { AuthClient } from "./auth.js";
import { type InternConfig } from "./config.js";
import { CredentialStore } from "./credential-store.js";
import { DeviceAuthorization, type OAuthCandidate } from "./device-authorization.js";
import {
  DEFAULT_RULE_BLOCK,
  defaultRuleFile,
  installDefaultRule,
  removeDefaultRule,
} from "./default-rule.js";
import {
  configureHost,
  HOST_DISPLAY_NAME,
  isSetupHost,
  SETUP_HOSTS,
  type CommandResult,
  type CommandRunner,
  type SetupHost,
} from "./setup-hosts.js";

export type { SetupHost } from "./setup-hosts.js";
export { SETUP_HOSTS } from "./setup-hosts.js";

const exec = promisify(execFile);
const defaultPackage = "@archastro/intern-mcp@latest";

interface SetupDependencies {
  token?: string;
  packageSpec?: string;
  promptToken?: () => Promise<string>;
  session?: (token: string, signal?: AbortSignal) => Promise<InternSession>;
  authorization?: {
    authorize(timeoutMs?: number, signal?: AbortSignal): Promise<OAuthCandidate>;
  };
  store?: {
    commit(candidate: OAuthCandidate, signal?: AbortSignal): Promise<void>;
  };
  legacyStore?: {
    replaceWithLegacy(accessToken: string, signal?: AbortSignal): Promise<void>;
  };
  configure?: typeof configureHost;
  fetch?: typeof fetch;
  run?: CommandRunner;
  write?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  verbose?: boolean;
  registry?: string;
  defaultRule?: "install" | "skip";
}

export function parseSetupOptions(args: string[]): {
  host: SetupHost;
  verbose: boolean;
  registry?: string;
  defaultRule: "install" | "skip" | "remove";
  manualToken?: true;
} {
  let host: SetupHost | undefined;
  let verbose = false;
  let registry: string | undefined;
  let defaultRule: "install" | "skip" | "remove" = "install";
  let manualToken = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--verbose") {
      verbose = true;
      continue;
    }
    if (value === "--no-default-rule") {
      if (defaultRule !== "install") throw new Error(setupUsage());
      defaultRule = "skip";
      continue;
    }
    if (value === "--remove-default-rule") {
      if (defaultRule !== "install") throw new Error(setupUsage());
      defaultRule = "remove";
      continue;
    }
    if (value === "--token") {
      if (manualToken) throw new Error(setupUsage());
      manualToken = true;
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
  return {
    host,
    verbose,
    defaultRule,
    ...(registry ? { registry } : {}),
    ...(manualToken ? { manualToken: true as const } : {}),
  };
}

export async function runSetup(
  config: InternConfig,
  host: SetupHost,
  dependencies: SetupDependencies = {},
): Promise<InternSession> {
  const cancellation = setupCancellation();
  let releaseLock: (() => Promise<void>) | undefined;
  const env = dependencies.env ?? process.env;
  const verbose = dependencies.verbose ?? false;
  const registry = dependencies.registry;
  const run = dependencies.run ?? runCommand;
  const configure = dependencies.configure ?? configureHost;
  const packageSpec =
    dependencies.packageSpec ?? env.INTERN_MCP_PACKAGE ?? defaultPackage;
  try {
    cancellation.signal.throwIfAborted();
    releaseLock = await acquireSetupLock(config.configRoot);
    cancellation.signal.throwIfAborted();
    const manualToken = dependencies.token?.trim();
    let verifiedSession: InternSession;
    if (manualToken) {
      verifiedSession = dependencies.session
        ? await dependencies.session(manualToken, cancellation.signal)
        : await verifyCandidate(
            config,
            manualToken,
            verbose,
            dependencies.fetch,
            cancellation.signal,
          );
      cancellation.signal.throwIfAborted();
      const legacyStore =
        dependencies.legacyStore ??
        new CredentialStore(config.configRoot, {
          platformBaseURL: config.archAstroBaseURL,
          oauthClientID: config.oauthClientID,
        });
      await legacyStore.replaceWithLegacy(manualToken, cancellation.signal);
    } else {
      const authorization =
        dependencies.authorization ??
        new DeviceAuthorization({
          platformBaseURL: config.archAstroBaseURL,
          publishableKey: config.publishableKey,
          oauthClientID: config.oauthClientID,
        });
      const store =
        dependencies.store ??
        new CredentialStore(config.configRoot, {
          platformBaseURL: config.archAstroBaseURL,
          oauthClientID: config.oauthClientID,
        });
      const candidate = await authorization.authorize(undefined, cancellation.signal);
      cancellation.signal.throwIfAborted();
      verifiedSession = dependencies.session
        ? await dependencies.session(candidate.accessToken, cancellation.signal)
        : await verifyCandidate(
            config,
            candidate.accessToken,
            verbose,
            dependencies.fetch,
            cancellation.signal,
          );
      cancellation.signal.throwIfAborted();
      await store.commit(candidate, cancellation.signal);
    }

    cancellation.signal.throwIfAborted();
    const extra = await configure(
      host,
      packageSpec,
      registry,
      env,
      run,
      cancellation.signal,
    );
    cancellation.signal.throwIfAborted();
    const write =
      dependencies.write ?? ((message: string) => process.stdout.write(message));
    const hostName = HOST_DISPLAY_NAME[host];
    write(
      `Intern connected to ${hostName} as ${verifiedSession.user.org_name} · ${verifiedSession.user.org_role}.\n${nextAction(host, extra)}`,
    );
    if ((dependencies.defaultRule ?? "install") === "install") {
      write(await applyDefaultRule(host, hostName, env));
    }
    return verifiedSession;
  } catch (error) {
    throw cancellation.interruption() ?? error;
  } finally {
    try {
      await releaseLock?.();
    } finally {
      cancellation.dispose();
    }
  }
}

export class SetupInterruptedError extends Error {
  readonly exitCode: number;

  constructor(readonly signal: "SIGINT" | "SIGTERM") {
    super(`setup interrupted by ${signal}`);
    this.name = "SetupInterruptedError";
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

function setupCancellation(): {
  signal: AbortSignal;
  interruption: () => SetupInterruptedError | undefined;
  dispose: () => void;
} {
  const controller = new AbortController();
  let interruption: SetupInterruptedError | undefined;
  const handlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (interruption) return;
      interruption = new SetupInterruptedError(signal);
      controller.abort(interruption);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    signal: controller.signal,
    interruption: () => interruption,
    dispose: () => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    },
  };
}

async function verifyCandidate(
  config: InternConfig,
  token: string,
  verbose: boolean,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<InternSession> {
  const diagnostic = verbose
    ? (line: string) => process.stderr.write(`${line}\n`)
    : undefined;
  return new InternAPI(config, new AuthClient(token), fetchFn, diagnostic).session(
    signal,
  );
}

function nextAction(host: SetupHost, hostInstruction?: string): string {
  if (host === "pi") {
    return `${hostInstruction ?? "Pi requires its MCP adapter: pi install npm:pi-mcp-adapter\n"}Start a new Pi session, then ask it to run intern_auth_status.\n`;
  }
  const sessionName: Record<Exclude<SetupHost, "pi">, string> = {
    codex: "Codex task",
    claude: "Claude Code session",
    grok: "Grok session",
    cursor: "Cursor session",
    opencode: "OpenCode session",
    rovodev: "Rovo Dev session",
  };
  return `Start a new ${sessionName[host]}, then ask it to run intern_auth_status.\n`;
}

async function runCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  try {
    const result = await exec(command, args, {
      env: process.env,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    return { status: 0, stdout: result.stdout };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
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
  const escape = String.fromCharCode(27);
  const terminal = Boolean((input as { isTTY?: boolean }).isTTY);
  const readable = input as NodeJS.ReadStream;
  const raw = terminal && typeof readable.setRawMode === "function";
  if (raw) readable.setRawMode(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let paintedRows = 0;

    const paint = () => {
      if (!terminal) return;
      const line = `${prompt}${"*".repeat(Array.from(buffer).length)}`;
      const columns = terminalColumns(output);
      // CR+EL only clears the current wrapped row, so a pasted token longer
      // than the terminal reprints the prompt on every remaining character.
      // Move back to the first painted row and erase to the end of the screen.
      if (paintedRows > 0) {
        if (paintedRows > 1) output.write(`${escape}[${paintedRows - 1}A`);
        output.write(`\r${escape}[J`);
      }
      output.write(line);
      // xenl: writing an exact multiple of the width leaves the cursor on the
      // last cell of the last filled row; the wrap happens on the next character.
      paintedRows = Math.max(1, Math.ceil(line.length / columns));
    };

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      try {
        if (raw) readable.setRawMode(false);
      } finally {
        // resume() keeps a TTY/pipe referenced; without pause the process
        // stays alive after a successful paste until the user sends Ctrl-C.
        input.pause();
        if (typeof readable.unref === "function") readable.unref();
        action();
      }
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
      let dirty = false;
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
          dirty = true;
          continue;
        }
        if (char === "\u0015") {
          buffer = "";
          dirty = true;
          continue;
        }
        if (char >= " " || char === "\t") {
          buffer += char;
          dirty = true;
        }
      }
      if (dirty) paint();
    };

    if (terminal) paint();
    else output.write(prompt);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

function terminalColumns(output: NodeJS.WritableStream): number {
  const columns = (output as { columns?: unknown }).columns;
  return typeof columns === "number" && Number.isInteger(columns) && columns > 0
    ? columns
    : 80;
}

function stripPasteBrackets(value: string): string {
  const escape = String.fromCharCode(27);
  return value.split(`${escape}[200~`).join("").split(`${escape}[201~`).join("");
}

// The default rule is the growth loop: it makes Intern the agent's standing
// answer for "share this with the team". Installing it is loud, opt-out, and
// reversible; a config side effect a user cannot see or undo would cost more
// trust than the rule earns.
async function applyDefaultRule(
  host: SetupHost,
  hostName: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const file = defaultRuleFile(host, env);
  if (!file) {
    return `To make Intern ${hostName}'s default for team pages, add this to its instructions:\n${DEFAULT_RULE_BLOCK}\n`;
  }
  const outcome = await installDefaultRule(file);
  if (outcome === "unchanged") return "";
  return `Made Intern ${hostName}'s default for team pages (${file}).\nUndo anytime: intern-mcp setup --host ${host} --remove-default-rule\n`;
}

export async function removeDefaultRuleForHost(
  host: SetupHost,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const file = defaultRuleFile(host, env);
  if (!file) {
    return `${HOST_DISPLAY_NAME[host]} has no Intern default rule managed by setup.\n`;
  }
  const removed = await removeDefaultRule(file);
  return removed
    ? `Removed the Intern default rule from ${file}.\n`
    : `No Intern default rule found in ${file}.\n`;
}

function setupUsage(): string {
  return `Usage: intern-mcp setup --host ${SETUP_HOSTS.join("|")} [--token] [--verbose] [--registry URL] [--no-default-rule | --remove-default-rule]`;
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

function accessTokenFile(config: InternConfig): string {
  return path.join(config.configRoot, "access-token");
}

async function acquireSetupLock(configRoot: string): Promise<() => Promise<void>> {
  await fs.mkdir(configRoot, { recursive: true, mode: 0o700 });
  const lockFile = path.join(configRoot, "setup.lock");
  try {
    const handle = await fs.open(lockFile, "wx", 0o600);
    const ownership = `${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`;
    await handle.writeFile(ownership);
    return async () => {
      await handle.close();
      const current = await fs.readFile(lockFile, "utf8").catch(() => undefined);
      if (current === ownership) await fs.rm(lockFile, { force: true });
    };
  } catch (error) {
    if (!isExists(error)) throw error;
    const owner = setupLockOwner(await fs.readFile(lockFile, "utf8").catch(() => ""));
    if (owner > 0 && processIsAlive(owner)) {
      throw new Error("Another Intern setup is already running");
    }
    throw new Error(
      `A stale Intern setup lock exists at ${lockFile}; remove it and retry`,
    );
  }
}

function setupLockOwner(contents: string): number {
  try {
    const value = JSON.parse(contents) as { pid?: unknown };
    if (typeof value.pid === "number") return value.pid;
  } catch {
    // Accept the original PID-only lock format during migration.
  }
  return Number.parseInt(contents, 10);
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
