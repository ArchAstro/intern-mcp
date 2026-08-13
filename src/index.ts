#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AuthClient } from "./auth.js";
import { InternAPI } from "./api.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { WorkspaceManager } from "./workspace.js";
import { SSHCredentialManager } from "./ssh.js";

const config = loadConfig();
const auth = new AuthClient(config);
const api = new InternAPI(config, auth);
const ssh = new SSHCredentialManager(config, api);
const workspaces = new WorkspaceManager(config, ssh);
const command = process.argv[2] ?? "serve";

switch (command) {
  case "serve":
    await serveUntilClosed();
    break;
  case "login": {
    const instructions = await auth.startLogin(true);
    process.stderr.write(
      `Open ${instructions.verificationURIComplete}\nCode: ${instructions.userCode}\n`,
    );
    await auth.completeLogin();
    process.stdout.write(`${JSON.stringify(await api.session(), null, 2)}\n`);
    break;
  }
  case "logout":
    await auth.logout();
    process.stdout.write("Logged out of Intern.\n");
    break;
  case "status":
    process.stdout.write(`${JSON.stringify(await api.session(), null, 2)}\n`);
    break;
  default:
    process.stderr.write("Usage: intern-mcp serve|login|logout|status\n");
    process.exitCode = 2;
}

async function serveUntilClosed(): Promise<void> {
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
