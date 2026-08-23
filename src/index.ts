#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AuthClient } from "./auth.js";
import { refreshInstalledDefaultRules } from "./default-rule.js";
import { InternAPI } from "./api.js";
import { loadConfig, type InternConfig } from "./config.js";
import { buildServer } from "./server.js";
import { WorkspaceManager } from "./workspace.js";
import { SSHCredentialManager } from "./ssh.js";
import {
  parseSetupOptions,
  promptAccessToken,
  removeDefaultRuleForHost,
  runSetup,
  SetupInterruptedError,
} from "./setup.js";

interface LaunchDependencies {
  auth?: Pick<AuthClient, "accessToken">;
  serve?: (auth: Pick<AuthClient, "accessToken">) => Promise<void>;
  diagnostics?: (line: string) => void;
}

const packageVersion = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

export async function launchMcp(
  config: InternConfig,
  dependencies: LaunchDependencies = {},
): Promise<void> {
  if (dependencies.serve) {
    const auth = dependencies.auth ?? new AuthClient(config);
    await auth.accessToken();
    await dependencies.serve(auth);
    return;
  }
  const auth = new AuthClient(config);
  await auth.accessToken();
  await serveUntilClosed(config, auth, dependencies.diagnostics);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "version") {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }
  const config = loadConfig();
  const verbose =
    process.argv.includes("--verbose") || process.env.INTERN_MCP_VERBOSE === "1";
  const diagnostics = verbose
    ? (line: string) => process.stderr.write(`${line}\n`)
    : undefined;

  switch (command) {
    case "serve":
      await serveUntilClosed(config, new AuthClient(config), diagnostics);
      break;
    case "launch": {
      const refreshed = await refreshInstalledDefaultRules(process.env);
      if (refreshed.length > 0) {
        diagnostics?.(`Refreshed Intern default rule: ${refreshed.join(", ")}`);
      }
      await launchMcp(config, { diagnostics });
      break;
    }
    case "status":
      process.stdout.write(
        `${JSON.stringify(await new InternAPI(config, new AuthClient(config), fetch, diagnostics).session(), null, 2)}\n`,
      );
      break;
    case "setup":
      try {
        const options = parseSetupOptions(process.argv.slice(3));
        if (options.defaultRule === "remove") {
          process.stdout.write(
            await removeDefaultRuleForHost(options.host, process.env),
          );
          break;
        }
        const token = options.manualToken ? await promptAccessToken() : undefined;
        await runSetup(config, options.host, {
          ...(token !== undefined ? { token } : {}),
          verbose: options.verbose,
          registry: options.registry,
          defaultRule: options.defaultRule,
        });
      } catch (error) {
        process.stderr.write(
          `Intern setup failed: ${error instanceof Error ? error.message : "request failed"}\n`,
        );
        process.exitCode = error instanceof SetupInterruptedError ? error.exitCode : 1;
      }
      break;
    default:
      process.stderr.write(
        "Usage: intern-mcp version|serve|launch|status|setup --host codex|claude|grok|cursor|opencode|rovodev|pi [--token] [--verbose] [--registry URL] [--no-default-rule | --remove-default-rule]\n",
      );
      process.exitCode = 2;
  }
}

async function serveUntilClosed(
  config: InternConfig,
  auth: AuthClient,
  diagnosticSink?: (line: string) => void,
): Promise<void> {
  const api = new InternAPI(config, auth, fetch, diagnosticSink);
  const ssh = new SSHCredentialManager(config, api);
  const workspaces = new WorkspaceManager(config, ssh);
  const handle = serveStdio(() => buildServer(auth, api, workspaces));
  await new Promise<void>((resolve) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      process.stdin.removeListener("end", close);
      process.stdin.removeListener("close", close);
      process.removeListener("SIGINT", close);
      process.removeListener("SIGTERM", close);
      void (async () => {
        try {
          await handle.close();
        } finally {
          await workspaces.close();
        }
      })()
        .catch(() => {})
        .finally(resolve);
    };
    process.stdin.once("end", close);
    process.stdin.once("close", close);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

if (isDirectInvocation()) await main();

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
