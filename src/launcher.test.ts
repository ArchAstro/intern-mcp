import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup()),
  );
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind TCP");
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  return address.port;
}

describe("local launcher", () => {
  test("starts the MCP from the active worktree Aster ports used by a Devbox Intern stack", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "intern-mcp-launcher-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const platformWorkspace = path.join(root, "firstlanding");
    await mkdir(platformWorkspace);
    await writeFile(path.join(platformWorkspace, "aster.toml"), "[workspace]\n");

    // Stand in for the two real HTTP boundaries whose health gates MCP startup.
    const platformPort = await listen(
      createServer((_request, response) => response.end("ok")),
    );
    const frontendPort = await listen(
      createServer((_request, response) => response.end("ok")),
    );

    // Emit Aster's stable machine-readable contract for an active Devbox topology.
    const fakeAster = path.join(root, "aster");
    await writeFile(
      fakeAster,
      `#!/usr/bin/env node
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--json", "services", "ports"])) {
  process.stderr.write("unexpected Aster arguments\\n");
  process.exit(2);
}
process.stdout.write(JSON.stringify({
  workspace: process.cwd(),
  instances: [{
    supervisor_pid: 4242,
    status: "active",
    services: [
      { name: "intern-ctl-devbox", port_name: "intern-ctl", port: 5102 },
      { name: "intern-fe", port_name: "intern-fe", port: ${frontendPort} }
    ],
    ports: {
      platform: ${platformPort},
      "intern-fe": ${frontendPort},
      "intern-ctl": 5102,
      "intern-gateway-ssh": 2224
    }
  }]
}));
`,
    );
    await chmod(fakeAster, 0o755);
    const localEnv = path.join(root, "intern.env");
    await writeFile(
      localEnv,
      `ARCHASTRO_PUBLISHABLE_KEY=pk_test
INTERN_OAUTH_CLIENT_ID=cc_test
INTERN_DEVICE_VERIFICATION_URI=http://127.0.0.1:${frontendPort}/device
`,
    );

    // Cross the executable shell, Aster JSON, HTTP health, build, and MCP stdio boundaries.
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const transport = new StdioClientTransport({
      command: path.join(repository, "scripts/run-local.sh"),
      args: ["serve"],
      env: {
        ...process.env,
        ASTER_BIN: fakeAster,
        INTERN_PLATFORM_WORKSPACE: platformWorkspace,
        INTERN_LOCAL_ENV_FILE: localEnv,
        INTERN_CONFIG_ROOT: path.join(root, "config"),
        INTERN_WORKSPACE_ROOT: path.join(root, "sites"),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "local-launcher-proof", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(transport);

    // The externally observable MCP contract is available through the launched server.
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("intern_prepare_site");
    expect((await stat(path.join(root, "config/id_ed25519"))).mode & 0o777).toBe(0o600);
  }, 20_000);
});
