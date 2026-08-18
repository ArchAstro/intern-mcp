#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AuthClient } from "./auth.js";
import { InternAPI } from "./api.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { WorkspaceManager } from "./workspace.js";
import { SSHCredentialManager } from "./ssh.js";
import { parseSetupHost, readStoredAccessToken, runSetup } from "./setup.js";

const config = loadConfig();
const command = process.argv[2] ?? "serve";

switch (command) {
  case "serve":
    await serveUntilClosed(new AuthClient());
    break;
  case "launch":
    await serveUntilClosed(new AuthClient(await readStoredAccessToken(config)));
    break;
  case "status":
    process.stdout.write(
      `${JSON.stringify(await new InternAPI(config, new AuthClient()).session(), null, 2)}\n`,
    );
    break;
  case "setup":
    try {
      await runSetup(config, parseSetupHost(process.argv.slice(3)));
    } catch (error) {
      process.stderr.write(
        `Intern setup failed: ${error instanceof Error ? error.message : "request failed"}\n`,
      );
      process.exitCode = 1;
    }
    break;
  default:
    process.stderr.write(
      "Usage: intern-mcp serve|launch|status|setup --host codex|claude\n",
    );
    process.exitCode = 2;
}

async function serveUntilClosed(auth: AuthClient): Promise<void> {
  const api = new InternAPI(config, auth);
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
