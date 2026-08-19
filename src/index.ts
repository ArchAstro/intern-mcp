#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AuthClient } from "./auth.js";
import { InternAPI } from "./api.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { WorkspaceManager } from "./workspace.js";
import { SSHCredentialManager } from "./ssh.js";
import { parseSetupOptions, readStoredAccessToken, runSetup } from "./setup.js";

const config = loadConfig();
const command = process.argv[2] ?? "serve";
const verbose =
  process.argv.includes("--verbose") || process.env.INTERN_MCP_VERBOSE === "1";
const diagnostics = verbose
  ? (line: string) => process.stderr.write(`${line}\n`)
  : undefined;

switch (command) {
  case "serve":
    await serveUntilClosed(new AuthClient(), diagnostics);
    break;
  case "launch":
    await serveUntilClosed(
      new AuthClient(await readStoredAccessToken(config)),
      diagnostics,
    );
    break;
  case "status":
    process.stdout.write(
      `${JSON.stringify(await new InternAPI(config, new AuthClient(), fetch, diagnostics).session(), null, 2)}\n`,
    );
    break;
  case "setup":
    try {
      const options = parseSetupOptions(process.argv.slice(3));
      await runSetup(config, options.host, { verbose: options.verbose });
    } catch (error) {
      process.stderr.write(
        `Intern setup failed: ${error instanceof Error ? error.message : "request failed"}\n`,
      );
      process.exitCode = 1;
    }
    break;
  default:
    process.stderr.write(
      "Usage: intern-mcp serve|launch|status|setup --host codex|claude [--verbose]\n",
    );
    process.exitCode = 2;
}

async function serveUntilClosed(
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
