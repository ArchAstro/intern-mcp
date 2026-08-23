import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternSession } from "./api.js";
import type { InternConfig } from "./config.js";
import type { OAuthCandidate } from "./device-authorization.js";
import {
  parseSetupOptions,
  promptAccessToken,
  readStoredAccessToken,
  runSetup,
} from "./setup.js";

let root: string;
let config: InternConfig;
let env: NodeJS.ProcessEnv;
let executableBuild: Promise<void> | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-setup-test-"));
  config = {
    internBaseURL: "https://tryintern.dev",
    archAstroBaseURL: "https://platform.archastro.ai",
    publishableKey: "pk_test",
    oauthClientID: "cc_test",
    workspaceRoot: path.join(root, "sites"),
    configRoot: path.join(root, "config"),
  };
  env = {
    HOME: root,
    CODEX_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    INTERN_WORKSPACE_ROOT: "/tmp/Intern",
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const session: InternSession = {
  user: {
    id: "usr_1",
    org: "org_1",
    org_name: "Acme",
    org_role: "admin",
  },
  org: { id: "intorg_1", slug: "acme", state: "active" },
};

const candidate: OAuthCandidate = {
  platformBaseURL: "https://platform.archastro.ai",
  oauthClientID: "cc_test",
  accessToken: "oauth-access-token",
  refreshToken: "oauth-refresh-token",
  expiresAtMs: 2_000_000_000_000,
  scope: "profile",
};

const rejectTokenPrompt = async (): Promise<string> => {
  throw new Error("setup prompted for a token");
};

describe("Intern MCP setup", () => {
  it("authorizes, verifies the candidate, commits it, then configures the host", async () => {
    const order: string[] = [];
    const promptToken = vi.fn(async () => "should-not-be-used");
    const authorization = {
      authorize: vi.fn(async () => {
        order.push("authorize");
        return candidate;
      }),
    };
    const store = {
      commit: vi.fn(async (received: OAuthCandidate) => {
        expect(received).toBe(candidate);
        order.push("commit");
      }),
    };
    const sessionVerifier = vi.fn(async (token: string) => {
      expect(token).toBe(candidate.accessToken);
      order.push("verify GET /api/v1/mcp/session");
      return session;
    });
    const configure = vi.fn(async () => {
      order.push("configure");
      return undefined;
    });

    await runSetup(config, "codex", {
      env,
      authorization,
      store,
      session: sessionVerifier,
      configure,
      promptToken,
      write: () => {},
    });

    expect(order).toEqual([
      "authorize",
      "verify GET /api/v1/mcp/session",
      "commit",
      "configure",
    ]);
    expect(promptToken).not.toHaveBeenCalled();
    expect(configure).toHaveBeenCalledWith(
      "codex",
      "@archastro/intern-mcp@latest",
      undefined,
      env,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(configure.mock.calls)).not.toContain(candidate.accessToken);
  });

  it("verifies the in-memory candidate through TryIntern GET /api/v1/mcp/session", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify(session), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await runSetup(config, "codex", {
      env,
      authorization: { authorize: async () => candidate },
      store: { commit: async () => {} },
      configure: async () => undefined,
      fetch: fetchFn as typeof fetch,
      write: () => {},
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://tryintern.dev/api/v1/mcp/session");
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.headers).toEqual(
      expect.objectContaining({
        authorization: `Bearer ${candidate.accessToken}`,
      }),
    );
  });

  it.each([
    "authorization denied",
    "authorization expired",
    "authorization interrupted",
    "OAuth response missing access_token",
    "authorization transport failed",
  ])("leaves credentials and host unchanged when %s", async (message) => {
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.writeFile(path.join(config.configRoot, "access-token"), "legacy\n");
    await fs.writeFile(path.join(config.configRoot, "credentials.json"), "oauth\n");
    const commit = vi.fn();
    const configure = vi.fn();

    await expect(
      runSetup(config, "codex", {
        env,
        authorization: {
          authorize: async () => {
            throw new Error(message);
          },
        },
        store: { commit },
        configure,
        promptToken: rejectTokenPrompt,
      }),
    ).rejects.toThrow(message);

    await expect(
      fs.readFile(path.join(config.configRoot, "access-token"), "utf8"),
    ).resolves.toBe("legacy\n");
    await expect(
      fs.readFile(path.join(config.configRoot, "credentials.json"), "utf8"),
    ).resolves.toBe("oauth\n");
    expect(commit).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
  });

  it("leaves both credential formats and the host unchanged when verification fails", async () => {
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.writeFile(path.join(config.configRoot, "access-token"), "legacy\n");
    await fs.writeFile(path.join(config.configRoot, "credentials.json"), "oauth\n");
    const commit = vi.fn();
    const configure = vi.fn();

    await expect(
      runSetup(config, "codex", {
        env,
        authorization: { authorize: async () => candidate },
        store: { commit },
        session: async () => {
          throw new Error("AUTH_REQUIRED: rejected");
        },
        configure,
        promptToken: rejectTokenPrompt,
      }),
    ).rejects.toThrow("AUTH_REQUIRED");

    expect(commit).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    await expect(
      fs.readFile(path.join(config.configRoot, "access-token"), "utf8"),
    ).resolves.toBe("legacy\n");
    await expect(
      fs.readFile(path.join(config.configRoot, "credentials.json"), "utf8"),
    ).resolves.toBe("oauth\n");
  });

  it("retains a verified committed credential when host registration fails", async () => {
    await expect(
      runSetup(config, "codex", {
        env,
        authorization: { authorize: async () => candidate },
        session: async () => session,
        configure: async () => {
          throw new Error("Could not configure Codex");
        },
        promptToken: rejectTokenPrompt,
      }),
    ).rejects.toThrow("Could not configure Codex");
    const stored = JSON.parse(
      await fs.readFile(path.join(config.configRoot, "credentials.json"), "utf8"),
    ) as { tokens: { accessToken: string } };
    expect(stored.tokens.accessToken).toBe(candidate.accessToken);
  });

  it.each([
    [
      "valid",
      '{"version":1,"platformBaseURL":"https://platform.archastro.ai","oauthClientID":"cc_test","tokens":{"accessToken":"old","refreshToken":"old-refresh","expiresAtMs":2000000000000,"scope":"profile"}}\n',
    ],
    ["corrupt", "not-json\n"],
  ])(
    "makes an explicit manual token effective over %s OAuth state",
    async (_kind, oauthContents) => {
      await fs.mkdir(config.configRoot, { recursive: true });
      await fs.writeFile(
        path.join(config.configRoot, "credentials.json"),
        oauthContents,
      );
      await fs.writeFile(path.join(config.configRoot, "access-token"), "old-legacy\n");

      await runSetup(config, "codex", {
        token: "verified-manual-token",
        env,
        session: async () => session,
        configure: async () => undefined,
        write: () => {},
      });

      await expect(readStoredAccessToken(config)).resolves.toBe(
        "verified-manual-token",
      );
      await expect(
        fs.stat(path.join(config.configRoot, "credentials.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves prior OAuth and legacy bytes when manual-token verification fails", async () => {
    const oauthFile = path.join(config.configRoot, "credentials.json");
    const legacyFile = path.join(config.configRoot, "access-token");
    const oauthBytes = Buffer.from("prior-oauth-bytes\n");
    const legacyBytes = Buffer.from("prior-legacy-bytes\n");
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.writeFile(oauthFile, oauthBytes);
    await fs.writeFile(legacyFile, legacyBytes);

    await expect(
      runSetup(config, "codex", {
        token: "rejected-manual-token",
        env,
        session: async () => {
          throw new Error("AUTH_REQUIRED: rejected");
        },
        configure: vi.fn(),
      }),
    ).rejects.toThrow("AUTH_REQUIRED");

    await expect(fs.readFile(oauthFile)).resolves.toEqual(oauthBytes);
    await expect(fs.readFile(legacyFile)).resolves.toEqual(legacyBytes);
  });

  it("ignores process-only INTERN_ACCESS_TOKEN during normal persistent setup", async () => {
    const authorization = { authorize: vi.fn(async () => candidate) };
    await runSetup(config, "codex", {
      env: { ...env, INTERN_ACCESS_TOKEN: "process-only-token" },
      authorization,
      store: { commit: async () => {} },
      session: async (token) => {
        expect(token).toBe(candidate.accessToken);
        return session;
      },
      configure: async () => undefined,
      write: () => {},
    });
    expect(authorization.authorize).toHaveBeenCalledOnce();
    await expect(
      fs.stat(path.join(config.configRoot, "access-token")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the explicit masked manual token instead of INTERN_ACCESS_TOKEN", async () => {
    const authorization = { authorize: vi.fn(async () => candidate) };
    const replaceWithLegacy = vi.fn(async () => {});
    const verify = vi.fn(async (token: string) => {
      expect(token).toBe("explicit-manual-token");
      return session;
    });
    await runSetup(config, "codex", {
      token: "explicit-manual-token",
      env: { ...env, INTERN_ACCESS_TOKEN: "process-only-token" },
      authorization,
      legacyStore: { replaceWithLegacy },
      session: verify,
      configure: async () => undefined,
      write: () => {},
    });
    expect(authorization.authorize).not.toHaveBeenCalled();
    expect(replaceWithLegacy).toHaveBeenCalledWith(
      "explicit-manual-token",
      expect.any(AbortSignal),
    );
  });

  it("cleans up a pending setup after real SIGINT and SIGTERM so setup is immediately retryable", async () => {
    await buildExecutable();
    const accessTokenFile = path.join(config.configRoot, "access-token");
    const credentialsFile = path.join(config.configRoot, "credentials.json");
    const cursorFile = path.join(root, ".cursor", "mcp.json");
    const legacyBytes = Buffer.from("existing-legacy-token\n");
    const oauthBytes = Buffer.from('{"existing":"oauth-record"}\n');
    const hostBytes = Buffer.from('{"mcpServers":{"intern":{"command":"old"}}}\n');
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.mkdir(path.dirname(cursorFile), { recursive: true });
    await fs.writeFile(accessTokenFile, legacyBytes);
    await fs.writeFile(credentialsFile, oauthBytes);
    await fs.writeFile(cursorFile, hostBytes);

    let tokenPolls = 0;
    const server = createServer(async (request, response) => {
      if (request.url === "/oauth/device/authorize") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            device_code: "pending-device-secret",
            user_code: "WAIT-0001",
            verification_uri: "https://tryintern.dev/device",
            verification_uri_complete: "https://tryintern.dev/device?code=WAIT-0001",
            expires_in: 600,
            interval: 60,
          }),
        );
        return;
      }
      if (request.url === "/oauth/token") {
        tokenPolls += 1;
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "authorization_pending" }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server missing");
    const baseURL = `http://127.0.0.1:${address.port}`;

    try {
      for (const [signal, expectedCode] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
      ] as const) {
        const pollsBefore = tokenPolls;
        const child = spawn(
          process.execPath,
          [path.join(process.cwd(), "dist", "index.js"), "setup", "--host", "cursor"],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              ...env,
              INTERN_CONFIG_ROOT: config.configRoot,
              INTERN_BASE_URL: baseURL,
              ARCHASTRO_API_URL: baseURL,
              ARCHASTRO_PUBLISHABLE_KEY: "pk_signal_test",
              INTERN_OAUTH_CLIENT_ID: "cc_signal_test",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const stderr: Buffer[] = [];
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        await waitUntil(async () => {
          const lockExists = await fs
            .stat(path.join(config.configRoot, "setup.lock"))
            .then(() => true)
            .catch(() => false);
          return lockExists && tokenPolls > pollsBefore;
        });

        const interruptedAt = Date.now();
        child.kill(signal);
        const result = await childExitWithin(child, 2_000);
        expect(Date.now() - interruptedAt).toBeLessThan(2_000);
        expect(result, Buffer.concat(stderr).toString("utf8")).toEqual({
          code: expectedCode,
          signal: null,
        });
        await expect(fs.readFile(accessTokenFile)).resolves.toEqual(legacyBytes);
        await expect(fs.readFile(credentialsFile)).resolves.toEqual(oauthBytes);
        await expect(fs.readFile(cursorFile)).resolves.toEqual(hostBytes);
        expect((await fs.readdir(config.configRoot)).sort()).toEqual([
          "access-token",
          "credentials.json",
        ]);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("aborts a delayed candidate verification before commit and exits promptly", async () => {
    await buildExecutable();
    const accessTokenFile = path.join(config.configRoot, "access-token");
    const credentialsFile = path.join(config.configRoot, "credentials.json");
    const cursorFile = path.join(root, ".cursor", "mcp.json");
    const legacyBytes = Buffer.from("existing-legacy-token\n");
    const oauthBytes = Buffer.from('{"existing":"oauth-record"}\n');
    const hostBytes = Buffer.from('{"mcpServers":{"intern":{"command":"old"}}}\n');
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.mkdir(path.dirname(cursorFile), { recursive: true });
    await fs.writeFile(accessTokenFile, legacyBytes);
    await fs.writeFile(credentialsFile, oauthBytes);
    await fs.writeFile(cursorFile, hostBytes);

    let verificationStarted = false;
    const server = createServer((request, response) => {
      if (request.url === "/oauth/device/authorize") {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("server missing");
        const deviceURL = `http://127.0.0.1:${address.port}/device`;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            device_code: "verification-device",
            user_code: "WAIT-0002",
            verification_uri: deviceURL,
            verification_uri_complete: `${deviceURL}?code=WAIT-0002`,
            expires_in: 600,
            interval: 60,
          }),
        );
        return;
      }
      if (request.url === "/oauth/token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "candidate-access",
            refresh_token: "candidate-refresh",
            expires_in: 3600,
            scope: "profile",
          }),
        );
        return;
      }
      if (request.url === "/api/v1/mcp/session") {
        verificationStarted = true;
        return;
      }
      response.writeHead(404).end();
    });
    const baseURL = await listenTestServer(server);
    const child = spawnSetup(root, config.configRoot, baseURL, "cursor");
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    try {
      await waitUntil(async () => verificationStarted);
      child.kill("SIGINT");
      const result = await childExitWithin(child, 2_000);
      expect(result, Buffer.concat(stderr).toString("utf8")).toEqual({
        code: 130,
        signal: null,
      });
      await expect(fs.readFile(accessTokenFile)).resolves.toEqual(legacyBytes);
      await expect(fs.readFile(credentialsFile)).resolves.toEqual(oauthBytes);
      await expect(fs.readFile(cursorFile)).resolves.toEqual(hostBytes);
      expect((await fs.readdir(config.configRoot)).sort()).toEqual([
        "access-token",
        "credentials.json",
      ]);
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("terminates a long-running host CLI after commit and retains verified OAuth", async () => {
    await buildExecutable();
    const fakeBin = path.join(root, "bin");
    const hostPIDFile = path.join(root, "host.pid");
    await fs.mkdir(fakeBin);
    const fakeCodex = path.join(fakeBin, "codex");
    await fs.writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.HOST_PID_FILE, String(process.pid));
setInterval(() => {}, 60000);
`,
      { mode: 0o755 },
    );
    const legacyFile = path.join(config.configRoot, "access-token");
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.writeFile(legacyFile, "prior-legacy\n", { mode: 0o600 });

    const server = createServer((request, response) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server missing");
      const deviceURL = `http://127.0.0.1:${address.port}/device`;
      if (request.url === "/oauth/device/authorize") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            device_code: "host-device",
            user_code: "WAIT-0003",
            verification_uri: deviceURL,
            verification_uri_complete: `${deviceURL}?code=WAIT-0003`,
            expires_in: 600,
            interval: 1,
          }),
        );
        return;
      }
      if (request.url === "/oauth/token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "committed-access",
            refresh_token: "committed-refresh",
            expires_in: 3600,
            scope: "profile",
          }),
        );
        return;
      }
      if (request.url === "/api/v1/mcp/session") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(session));
        return;
      }
      response.writeHead(404).end();
    });
    const baseURL = await listenTestServer(server);
    const child = spawnSetup(root, config.configRoot, baseURL, "codex", {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      HOST_PID_FILE: hostPIDFile,
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    try {
      await waitUntil(async () =>
        fs
          .stat(hostPIDFile)
          .then(() => true)
          .catch(() => false),
      );
      const hostPID = Number.parseInt(await fs.readFile(hostPIDFile, "utf8"), 10);
      child.kill("SIGTERM");
      const result = await childExitWithin(child, 2_000);
      expect(result).toEqual({ code: 143, signal: null });
      expect(Buffer.concat(stdout).toString("utf8")).not.toContain("Intern connected");
      await waitUntil(async () => !processAlive(hostPID));
      const stored = JSON.parse(
        await fs.readFile(path.join(config.configRoot, "credentials.json"), "utf8"),
      ) as { tokens: { accessToken: string } };
      expect(stored.tokens.accessToken).toBe("committed-access");
      await expect(fs.readFile(legacyFile, "utf8")).resolves.toBe("prior-legacy\n");
      expect((await fs.readdir(config.configRoot)).sort()).toEqual([
        "access-token",
        "credentials.json",
      ]);
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("aborts a browser replacement waiting behind another process without disturbing its lock", async () => {
    await buildExecutable();
    const coordination = path.join(root, "coordination");
    await fs.mkdir(coordination);
    const server = createServer((request, response) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server missing");
      const deviceURL = `http://127.0.0.1:${address.port}/device`;
      if (request.url === "/oauth/device/authorize") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            device_code: "waiting-replacement",
            user_code: "WAIT-0004",
            verification_uri: deviceURL,
            verification_uri_complete: `${deviceURL}?code=WAIT-0004`,
            expires_in: 600,
            interval: 1,
          }),
        );
        return;
      }
      if (request.url === "/oauth/token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "replacement-access",
            refresh_token: "replacement-refresh",
            expires_in: 3600,
            scope: "profile",
          }),
        );
        return;
      }
      if (request.url === "/api/v1/mcp/session") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(session));
        return;
      }
      response.writeHead(404).end();
    });
    const baseURL = await listenTestServer(server);
    await fs.mkdir(config.configRoot, { recursive: true });
    const credentialsFile = path.join(config.configRoot, "credentials.json");
    const oldRecord = {
      version: 1,
      platformBaseURL: baseURL,
      oauthClientID: "cc_signal_test",
      tokens: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAtMs: 1,
        scope: "profile",
      },
    };
    await fs.writeFile(credentialsFile, `${JSON.stringify(oldRecord)}\n`, {
      mode: 0o600,
    });
    const moduleURL = pathToFileURL(
      path.join(process.cwd(), "dist", "credential-store.js"),
    ).href;
    const ownerScript = String.raw`
      import fs from "node:fs/promises";
      import path from "node:path";
      import { CredentialStore } from ${JSON.stringify(moduleURL)};
      const [configRoot, coordination, platformBaseURL] = process.argv.slice(1);
      const store = new CredentialStore(configRoot, { platformBaseURL, oauthClientID: "cc_signal_test" });
      const result = await store.withRefreshLock(async (current) => {
        await fs.writeFile(path.join(coordination, "owner-started"), "started\n", { flag: "wx" });
        while (!(await fs.stat(path.join(coordination, "release-owner")).then(() => true).catch(() => false))) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return {
          result: "owner-complete",
          record: {
            ...current,
            tokens: { ...current.tokens, accessToken: "owner-refreshed", refreshToken: "owner-rotated" },
          },
        };
      });
      process.stdout.write(result);
    `;
    const owner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        ownerScript,
        config.configRoot,
        coordination,
        baseURL,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const ownerOutput: Buffer[] = [];
    owner.stdout.on("data", (chunk: Buffer) => ownerOutput.push(chunk));
    let setupChild: ReturnType<typeof spawn> | undefined;
    try {
      await waitUntil(async () =>
        fs
          .stat(path.join(coordination, "owner-started"))
          .then(() => true)
          .catch(() => false),
      );
      setupChild = spawnSetup(root, config.configRoot, baseURL, "cursor");
      await waitUntil(async () => {
        const entries = await fs.readdir(config.configRoot);
        return (
          entries.filter(
            (entry) => entry.startsWith(".refresh-intent.") && entry.endsWith(".json"),
          ).length >= 2
        );
      });
      setupChild.kill("SIGINT");
      await expect(childExitWithin(setupChild, 2_000)).resolves.toEqual({
        code: 130,
        signal: null,
      });
      const whileOwnerRuns = await fs.readdir(config.configRoot);
      expect(
        whileOwnerRuns.filter((entry) => entry.startsWith(".refresh-intent.")),
      ).toHaveLength(1);
      expect(whileOwnerRuns).toContain("refresh.lock");
      expect(processAlive(owner.pid!)).toBe(true);
      expect(
        JSON.parse(await fs.readFile(credentialsFile, "utf8")).tokens.accessToken,
      ).toBe("old-access");
      await expect(
        fs.stat(path.join(config.configRoot, "setup.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await fs.writeFile(path.join(coordination, "release-owner"), "release\n");
      await expect(childExitWithin(owner, 2_000)).resolves.toEqual({
        code: 0,
        signal: null,
      });
      expect(Buffer.concat(ownerOutput).toString("utf8")).toBe("owner-complete");
      expect(
        JSON.parse(await fs.readFile(credentialsFile, "utf8")).tokens.accessToken,
      ).toBe("owner-refreshed");
      expect(
        (await fs.readdir(config.configRoot)).filter((entry) =>
          entry.startsWith(".refresh"),
        ),
      ).toEqual([]);
    } finally {
      setupChild?.kill("SIGKILL");
      owner.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it.each([
    ["codex", "Start a new Codex task"],
    ["claude", "Start a new Claude Code session"],
    ["grok", "Start a new Grok session"],
    ["cursor", "Start a new Cursor session"],
    ["opencode", "Start a new OpenCode session"],
    ["rovodev", "Start a new Rovo Dev session"],
    ["pi", "pi install npm:pi-mcp-adapter"],
  ] as const)("prints the next action for %s", async (host, expected) => {
    const output: string[] = [];
    await runSetup(config, host, {
      env,
      authorization: { authorize: async () => candidate },
      store: { commit: async () => {} },
      session: async () => session,
      configure: async () => undefined,
      promptToken: rejectTokenPrompt,
      write: (message) => output.push(message),
    });
    expect(output.join("")).toContain(expected);
    expect(output.join("")).toContain("intern_auth_status");
  });

  it("validates the token, stores it privately, then configures Codex", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const validate = vi.fn(async () => session);
    const output: string[] = [];
    await runSetup(config, "codex", {
      token: "secret-token",
      packageSpec: "/tmp/intern-mcp.tgz",
      env,
      session: validate,
      run: async (command, args) => {
        calls.push({ command, args });
        return {
          status: 0,
          stdout: args.includes("get")
            ? '{"command": "npx", "args": ["intern-mcp", "launch"]}'
            : "ok",
        };
      },
      write: (message) => output.push(message),
    });

    expect(validate).toHaveBeenCalledWith("secret-token", expect.any(AbortSignal));
    await expect(readStoredAccessToken(config)).resolves.toBe("secret-token");
    expect(
      (await fs.stat(path.join(config.configRoot, "access-token"))).mode & 0o777,
    ).toBe(0o600);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: "codex",
      args: expect.arrayContaining([
        "add",
        "INTERN_WORKSPACE_ROOT=/tmp/Intern",
        "--prefer-online",
        "--package=/tmp/intern-mcp.tgz",
        "launch",
      ]),
    });
    expect(calls[0].args.join(" ")).not.toContain("secret-token");
    expect(calls[0].args.join(" ")).not.toContain("--@archastro:registry=");
    expect(calls[1]).toEqual({
      command: "codex",
      args: ["mcp", "get", "intern", "--json"],
    });
    expect(output.join("")).toContain("Intern connected to Codex as Acme · admin");
    expect(output.join("")).not.toContain("secret-token");
  });

  it("saves the plain public latest launcher on normal setup", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const routedEnv = {
      ...env,
      ARCHASTRO_API_URL: "https://platform.local.example",
      ARCHASTRO_PUBLISHABLE_KEY: "pk_local_public",
      INTERN_OAUTH_CLIENT_ID: "cc_local_public",
    };
    await runSetup(config, "codex", {
      token: "secret-token",
      env: routedEnv,
      session: async () => session,
      run: async (command, args) => {
        calls.push({ command, args });
        return {
          status: 0,
          stdout: args.includes("get")
            ? '{"command": "npx", "args": ["intern-mcp", "launch"]}'
            : "ok",
        };
      },
      write: () => {},
    });

    expect(calls[0]).toMatchObject({
      command: "codex",
      args: expect.arrayContaining([
        "--prefer-online",
        "ARCHASTRO_API_URL=https://platform.local.example",
        "ARCHASTRO_PUBLISHABLE_KEY=pk_local_public",
        "INTERN_OAUTH_CLIENT_ID=cc_local_public",
        "--package=@archastro/intern-mcp@latest",
        "intern-mcp",
        "launch",
      ]),
    });
    expect(calls[0].args.join(" ")).not.toContain("--@archastro:registry=");
  });

  it("keeps an explicit registry override in the saved launcher", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await runSetup(config, "codex", {
      token: "secret-token",
      env,
      registry: "https://registry.npmjs.org",
      session: async () => session,
      run: async (command, args) => {
        calls.push({ command, args });
        return {
          status: 0,
          stdout: args.includes("get")
            ? '{"command": "npx", "args": ["intern-mcp", "launch"]}'
            : "ok",
        };
      },
      write: () => {},
    });

    expect(calls[0]).toMatchObject({
      command: "codex",
      args: expect.arrayContaining([
        "--prefer-online",
        "--@archastro:registry=https://registry.npmjs.org",
        "--package=@archastro/intern-mcp@latest",
        "intern-mcp",
        "launch",
      ]),
    });
  });

  it("replaces only Claude's user-scoped Intern entry", async () => {
    const calls: string[][] = [];
    await runSetup(config, "claude", {
      token: "secret-token",
      env,
      session: async () => session,
      run: async (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stdout: args.includes("get")
            ? "Scope: User config\nStatus: ✓ Connected\nCommand: npx\nArgs: intern-mcp launch"
            : "ok",
        };
      },
      write: () => {},
    });

    expect(calls[0]).toEqual(["claude", "mcp", "remove", "--scope", "user", "intern"]);
    expect(calls[1]).toEqual(
      expect.arrayContaining(["claude", "add", "--scope", "user", "launch"]),
    );
    expect(calls[1].join(" ")).not.toContain("secret-token");
    expect(calls[2]).toEqual(["claude", "mcp", "get", "intern"]);
  });

  it("rejects a connected Claude entry from a shadowing local scope", async () => {
    await expect(
      runSetup(config, "claude", {
        token: "secret-token",
        env,
        session: async () => session,
        run: async (_command, args) => ({
          status: 0,
          stdout: args.includes("get")
            ? "Scope: Local config\nStatus: ✓ Connected\nCommand: npx\nArgs: Scope: User intern-mcp launch"
            : "ok",
        }),
      }),
    ).rejects.toThrow("remove any local/project intern entry");
  });

  it("keeps the new token when Codex commits but readback verification fails", async () => {
    await expect(
      runSetup(config, "codex", {
        token: "new-token",
        env,
        session: async () => session,
        run: async (_command, args) => ({
          status: args.includes("get") ? 1 : 0,
          stdout: "",
        }),
      }),
    ).rejects.toThrow("new profile was retained");
    await expect(readStoredAccessToken(config)).resolves.toBe("new-token");
  });

  it("retains the verified token but restores host config when replacement fails", async () => {
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.writeFile(path.join(config.configRoot, "access-token"), "old-token\n", {
      mode: 0o600,
    });
    await fs.mkdir(env.CLAUDE_CONFIG_DIR!, { recursive: true });
    const configFile = path.join(env.CLAUDE_CONFIG_DIR!, ".claude.json");
    const previous = '{"mcpServers":{"intern":{"command":"old"}}}\n';
    await fs.writeFile(configFile, previous, { mode: 0o600 });

    await expect(
      runSetup(config, "claude", {
        token: "new-token",
        env,
        session: async () => session,
        run: async (_command, args) => {
          if (args.includes("remove")) {
            const document = JSON.parse(await fs.readFile(configFile, "utf8"));
            delete document.mcpServers.intern;
            await fs.writeFile(configFile, `${JSON.stringify(document)}\n`);
          }
          return { status: args.includes("add") ? 1 : 0, stdout: "" };
        },
      }),
    ).rejects.toThrow("Could not configure Claude Code");

    await expect(readStoredAccessToken(config)).resolves.toBe("new-token");
    expect(JSON.parse(await fs.readFile(configFile, "utf8"))).toEqual(
      JSON.parse(previous),
    );
  });

  it("fails without changing host config when token validation fails", async () => {
    const run = vi.fn();
    await expect(
      runSetup(config, "codex", {
        token: "rejected-token",
        env,
        session: async () => {
          throw new Error("AUTH_REQUIRED: invalid_token");
        },
        run,
      }),
    ).rejects.toThrow("AUTH_REQUIRED");
    expect(run).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(config.configRoot, "access-token")),
    ).rejects.toThrow();
  });

  it("refuses a parallel setup before changing the stored token", async () => {
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.writeFile(path.join(config.configRoot, "setup.lock"), `${process.pid}\n`);

    await expect(
      runSetup(config, "codex", {
        token: "new-token",
        env,
        session: async () => session,
        run: vi.fn(),
      }),
    ).rejects.toThrow("Another Intern setup is already running");
    await expect(
      fs.stat(path.join(config.configRoot, "access-token")),
    ).rejects.toThrow();
  });

  it("does not remove a setup lock that was replaced by a different owner", async () => {
    const lockFile = path.join(config.configRoot, "setup.lock");
    const successor = `${JSON.stringify({ pid: process.pid, token: "successor" })}\n`;

    await runSetup(config, "codex", {
      token: "verified-token",
      env,
      session: async () => session,
      configure: async () => {
        await fs.rm(lockFile);
        await fs.writeFile(lockFile, successor, { mode: 0o600 });
        return undefined;
      },
      write: () => {},
    });

    await expect(fs.readFile(lockFile, "utf8")).resolves.toBe(successor);
  });

  it("removes temporary signal handlers after setup succeeds or fails", async () => {
    const before = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    await runSetup(config, "codex", {
      token: "verified-token",
      env,
      session: async () => session,
      configure: async () => undefined,
      write: () => {},
    });
    await expect(
      runSetup(config, "codex", {
        env,
        authorization: {
          authorize: async () => {
            throw new Error("expected authorization failure");
          },
        },
      }),
    ).rejects.toThrow("expected authorization failure");

    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
  });

  it("fails closed on a stale setup lock", async () => {
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.writeFile(path.join(config.configRoot, "setup.lock"), "99999999\n");

    await expect(
      runSetup(config, "codex", {
        token: "new-token",
        env,
        session: async () => session,
        run: vi.fn(),
      }),
    ).rejects.toThrow("stale Intern setup lock");
    await expect(
      fs.readFile(path.join(config.configRoot, "setup.lock"), "utf8"),
    ).resolves.toBe("99999999\n");
  });

  it("accepts supported hosts and opt-in verbose diagnostics", () => {
    expect(parseSetupOptions(["--host", "codex"])).toEqual({
      host: "codex",
      verbose: false,
      defaultRule: "install",
    });
    expect(parseSetupOptions(["--host", "codex", "--token"])).toEqual({
      host: "codex",
      verbose: false,
      defaultRule: "install",
      manualToken: true,
    });
    expect(() => parseSetupOptions(["--host", "codex", "--token=secret"])).toThrow(
      "Usage:",
    );
    expect(parseSetupOptions(["--verbose", "--host=claude"])).toEqual({
      host: "claude",
      verbose: true,
      defaultRule: "install",
    });
    expect(
      parseSetupOptions(["--host=codex", "--registry", "https://registry.npmjs.org/"]),
    ).toEqual({
      host: "codex",
      verbose: false,
      defaultRule: "install",
      registry: "https://registry.npmjs.org",
    });
    expect(parseSetupOptions(["--host", "cursor"])).toEqual({
      host: "cursor",
      verbose: false,
      defaultRule: "install",
    });
    expect(parseSetupOptions(["--host", "grok"])).toEqual({
      host: "grok",
      verbose: false,
      defaultRule: "install",
    });
    expect(() => parseSetupOptions(["--host", "windsurf"])).toThrow("Usage:");
    expect(() => parseSetupOptions(["--host", "codex", "--debug"])).toThrow("Usage:");
    expect(() =>
      parseSetupOptions([
        "--host",
        "codex",
        "--registry=https://user:secret@example.com",
      ]),
    ).toThrow("Usage:");
  });

  it("reads a piped token without echoing it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let visible = "";
    output.on("data", (chunk) => (visible += chunk.toString()));
    input.end("secret-token\n");

    await expect(promptAccessToken(input, output)).resolves.toBe("secret-token");
    expect(visible).toContain("Paste Intern access token");
    expect(visible).not.toContain("secret-token");
  });

  it("renders one asterisk per pasted token character on a terminal", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    output.isTTY = true;
    let visible = "";
    output.on("data", (chunk) => (visible += chunk.toString()));
    input.end("secret-token\n");

    await expect(promptAccessToken(input, output)).resolves.toBe("secret-token");
    expect(visible).toContain("*".repeat("secret-token".length));
    expect(visible).not.toContain("secret-token");
  });

  it("writes Cursor, OpenCode, Rovo Dev, and Pi config without embedding the token", async () => {
    const run = vi.fn();
    for (const host of ["cursor", "opencode", "rovodev", "pi"] as const) {
      await runSetup(config, host, {
        token: "secret-token",
        packageSpec: "/tmp/intern-mcp.tgz",
        env,
        session: async () => session,
        run,
        write: () => {},
      });
    }
    expect(run).not.toHaveBeenCalled();

    const cursor = JSON.parse(
      await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
    );
    expect(cursor.mcpServers.intern).toMatchObject({
      type: "stdio",
      command: "npx",
    });
    expect(cursor.mcpServers.intern.args).toEqual(
      expect.arrayContaining(["intern-mcp", "launch", "--package=/tmp/intern-mcp.tgz"]),
    );
    expect(JSON.stringify(cursor)).not.toContain("secret-token");

    const opencode = JSON.parse(
      await fs.readFile(
        path.join(root, ".config", "opencode", "opencode.json"),
        "utf8",
      ),
    );
    expect(opencode.mcp.intern.command).toEqual(
      expect.arrayContaining(["npx", "intern-mcp", "launch"]),
    );
    expect(opencode.mcp.intern.enabled).toBe(true);

    const rovodev = JSON.parse(
      await fs.readFile(path.join(root, ".rovodev", "mcp.json"), "utf8"),
    );
    expect(rovodev.mcpServers.intern.transport).toBe("stdio");
    expect(rovodev.mcpServers.intern.args).toContain("launch");

    const pi = JSON.parse(
      await fs.readFile(path.join(root, ".config", "mcp", "mcp.json"), "utf8"),
    );
    expect(pi.mcpServers.intern.command).toBe("npx");
    expect(pi.mcpServers.intern.args).toContain("intern-mcp");
  });

  it("tells Pi users to install the MCP adapter", async () => {
    const output: string[] = [];
    await runSetup(config, "pi", {
      token: "secret-token",
      env,
      session: async () => session,
      write: (message) => output.push(message),
    });
    expect(output.join("")).toContain("pi install npm:pi-mcp-adapter");
    expect(output.join("")).toContain("Intern connected to Pi");
  });

  it("registers Grok through grok mcp add without putting the token in argv", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await runSetup(config, "grok", {
      token: "secret-token",
      packageSpec: "/tmp/intern-mcp.tgz",
      env,
      session: async () => session,
      run: async (command, args) => {
        calls.push({ command, args });
        return {
          status: 0,
          stdout: JSON.stringify({
            intern: { command: "npx", args: ["intern-mcp", "launch"] },
          }),
        };
      },
      write: () => {},
    });
    expect(calls[0]).toMatchObject({
      command: "grok",
      args: expect.arrayContaining(["mcp", "add", "intern", "-s", "user", "launch"]),
    });
    expect(calls[0].args.join(" ")).not.toContain("secret-token");
    expect(calls[1]).toEqual({
      command: "grok",
      args: ["mcp", "list", "--json"],
    });
  });

  it("masks a bracketed terminal paste as one asterisk per character", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    output.isTTY = true;
    let visible = "";
    output.on("data", (chunk) => (visible += chunk.toString()));
    const token = "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9";
    const escape = String.fromCharCode(27);
    const pending = promptAccessToken(input, output);
    input.write(`${escape}[200~${token}${escape}[201~\n`);
    await expect(pending).resolves.toBe(token);
    expect(visible).toContain("*".repeat(token.length));
    expect(visible).not.toContain("eyJ");
    expect(visible).not.toContain("[200~");
  });

  it("paints one asterisk per character when a token is pasted in one chunk", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    output.isTTY = true;
    let visible = "";
    output.on("data", (chunk) => (visible += chunk.toString()));
    const pending = promptAccessToken(input, output);
    input.write("eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9");
    input.write("\n");
    await expect(pending).resolves.toBe("eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9");
    expect(visible).toContain(
      "*".repeat("eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9".length),
    );
    expect(visible).not.toContain("eyJ");
  });

  it("rejects terminal cancellation instead of leaving setup pending", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    output.isTTY = true;

    const pending = promptAccessToken(input, output);
    input.write(String.fromCharCode(3));

    await expect(pending).rejects.toThrow("Token entry cancelled");
  });
});

async function runProcess(
  command: string,
  args: string[],
  processEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: processEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve) =>
    child.once("exit", (exitCode) => resolve(exitCode)),
  );
  if (code !== 0) throw new Error(Buffer.concat(stderr).toString("utf8"));
}

function buildExecutable(): Promise<void> {
  executableBuild ??= runProcess("npm", ["run", "build"], process.env);
  return executableBuild;
}

async function listenTestServer(
  server: ReturnType<typeof createServer>,
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server missing");
  return `http://127.0.0.1:${address.port}`;
}

function spawnSetup(
  home: string,
  configRoot: string,
  baseURL: string,
  host: "codex" | "cursor",
  extraEnv: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    [path.join(process.cwd(), "dist", "index.js"), "setup", "--host", host],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        INTERN_CONFIG_ROOT: configRoot,
        INTERN_WORKSPACE_ROOT: path.join(home, "sites"),
        INTERN_BASE_URL: baseURL,
        ARCHASTRO_API_URL: baseURL,
        ARCHASTRO_PUBLISHABLE_KEY: "pk_signal_test",
        INTERN_OAUTH_CLIENT_ID: "cc_signal_test",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function processAlive(pid: number): boolean {
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

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for child setup state");
}

async function childExitWithin(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: string | null }> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`child did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
