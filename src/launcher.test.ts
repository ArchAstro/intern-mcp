import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InternConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { AuthClient } from "./auth.js";
import { CredentialStore } from "./credential-store.js";
import { DeviceAuthorization } from "./device-authorization.js";

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
  test("prints only the exact package version without requiring credentials", async () => {
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const packageVersion = JSON.parse(
      await readFile(path.join(repository, "package.json"), "utf8"),
    ).version as string;
    const root = await mkdtemp(path.join(os.tmpdir(), "intern-version-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const result = spawnSync(
      process.execPath,
      [path.join(repository, "dist", "index.js"), "version"],
      {
        encoding: "utf8",
        env: {
          HOME: root,
          INTERN_CONFIG_ROOT: path.join(root, "missing-credentials"),
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${packageVersion}\n`);
    expect(result.stderr).toBe("");
  });

  test("preflights credential resolution before exposing MCP stdio", async () => {
    const { launchMcp } = await import("./index.js");
    const order: string[] = [];
    const auth = {
      accessToken: vi.fn(async () => {
        order.push("preflight");
        return "valid-access-token";
      }),
    };
    const serve = vi.fn(async () => {
      order.push("serve");
    });

    await launchMcp({} as InternConfig, { auth, serve });

    expect(order).toEqual(["preflight", "serve"]);
  }, 1_000);

  test.each(["Stored Intern credentials are corrupt", "session refresh failed"])(
    "does not expose MCP stdio when preflight fails: %s",
    async (message) => {
      const { launchMcp } = await import("./index.js");
      const serve = vi.fn();
      const auth = {
        accessToken: vi.fn(async () => {
          throw new Error(message);
        }),
      };

      await expect(launchMcp({} as InternConfig, { auth, serve })).rejects.toThrow(
        message,
      );
      expect(serve).not.toHaveBeenCalled();
    },
  );

  test("does not expose stdio when the real refresh transport times out", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "intern-refresh-timeout-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const config = loadConfig({
      HOME: root,
      INTERN_CONFIG_ROOT: path.join(root, "config"),
      ARCHASTRO_API_URL: "https://platform.example",
      ARCHASTRO_PUBLISHABLE_KEY: "pk_test",
      INTERN_OAUTH_CLIENT_ID: "client_test",
    });
    const store = new CredentialStore(config.configRoot, {
      platformBaseURL: config.archAstroBaseURL,
      oauthClientID: config.oauthClientID,
    });
    await store.commit({
      platformBaseURL: config.archAstroBaseURL,
      oauthClientID: config.oauthClientID,
      accessToken: "expired-access",
      refreshToken: "stalled-refresh",
      expiresAtMs: 1,
      scope: "profile",
    });
    const authorization = new DeviceAuthorization(
      {
        platformBaseURL: config.archAstroBaseURL,
        publishableKey: config.publishableKey,
        oauthClientID: config.oauthClientID,
      },
      {
        requestTimeoutMs: 20,
        fetch: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      },
    );
    const auth = new AuthClient(config, {
      store,
      authorization,
      now: () => 10_000,
    });
    const serve = vi.fn();
    const { launchMcp } = await import("./index.js");

    await expect(launchMcp(config, { auth, serve })).rejects.toThrow(
      "refresh request timed out",
    );
    expect(serve).not.toHaveBeenCalled();
    expect(
      (await readdir(config.configRoot)).filter((entry) =>
        entry.startsWith(".refresh"),
      ),
    ).toEqual([]);
  });

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
    // Cross the executable shell, Aster JSON, HTTP health, build, and MCP stdio boundaries.
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const transport = new StdioClientTransport({
      command: path.join(repository, "scripts/run-local.sh"),
      args: ["serve"],
      env: {
        ...process.env,
        ASTER_BIN: fakeAster,
        INTERN_PLATFORM_WORKSPACE: platformWorkspace,
        INTERN_ACCESS_TOKEN: "launcher-proof-token",
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
