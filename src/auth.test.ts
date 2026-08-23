import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthClient } from "./auth.js";
import { CredentialStore, type OAuthCredentialRecord } from "./credential-store.js";
import type { OAuthCandidate } from "./device-authorization.js";
import { loadConfig } from "./config.js";

const roots: string[] = [];

async function fixture() {
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "intern-auth-"));
  roots.push(configRoot);
  const config = loadConfig({
    HOME: configRoot,
    INTERN_CONFIG_ROOT: configRoot,
    ARCHASTRO_API_URL: "https://platform.example",
    ARCHASTRO_PUBLISHABLE_KEY: "pk_public",
    INTERN_OAUTH_CLIENT_ID: "client_intern",
  });
  const store = new CredentialStore(configRoot, {
    platformBaseURL: config.archAstroBaseURL,
    oauthClientID: config.oauthClientID,
  });
  return { configRoot, config, store };
}

function candidate(overrides: Partial<OAuthCandidate> = {}): OAuthCandidate {
  return {
    platformBaseURL: "https://platform.example",
    oauthClientID: "client_intern",
    accessToken: "oauth-access",
    refreshToken: "oauth-refresh",
    expiresAtMs: 1_000_000,
    scope: "profile",
    ...overrides,
  };
}

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    authorize: vi.fn(async () => candidate()),
    refresh: vi.fn(async () =>
      candidate({
        accessToken: "refreshed-access",
        refreshToken: "rotated-refresh",
        expiresAtMs: 2_000_000,
      }),
    ),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("AuthClient", () => {
  it("returns a nonempty INTERN_ACCESS_TOKEN without reading or mutating the store", async () => {
    const store = {
      read: vi.fn(() => {
        throw new Error("must not read");
      }),
      withRefreshLock: vi.fn(),
      commit: vi.fn(),
    };
    const auth = new AuthClient(loadConfig({ HOME: "/tmp/unused" }), {
      env: { INTERN_ACCESS_TOKEN: "  env-token  " },
      store: store as never,
      authorization: authorization() as never,
    });

    await expect(auth.hasCredentials()).resolves.toBe(true);
    await expect(auth.accessToken()).resolves.toBe("env-token");
    expect(store.read).not.toHaveBeenCalled();
    expect(store.withRefreshLock).not.toHaveBeenCalled();
    expect(store.commit).not.toHaveBeenCalled();
  });

  it("prefers valid OAuth credentials and only reads legacy when OAuth is absent", async () => {
    const { configRoot, config, store } = await fixture();
    await fs.writeFile(path.join(configRoot, "access-token"), "legacy-token\n");
    await store.commit(candidate());
    const auth = new AuthClient(config, {
      env: {},
      store,
      authorization: authorization() as never,
      now: () => 0,
    });
    await expect(auth.accessToken()).resolves.toBe("oauth-access");

    await fs.rm(path.join(configRoot, "credentials.json"));
    await expect(auth.accessToken()).resolves.toBe("legacy-token");
  });

  it("does not refresh a token more than 60 seconds from expiry", async () => {
    const { config, store } = await fixture();
    await store.commit(candidate({ expiresAtMs: 160_001 }));
    const device = authorization();
    const auth = new AuthClient(config, {
      env: {},
      store,
      authorization: device as never,
      now: () => 100_000,
    });
    await expect(auth.accessToken()).resolves.toBe("oauth-access");
    expect(device.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["exactly at the 60 second window", 160_000],
    ["inside the 60 second window", 159_999],
    ["after expiry", 99_999],
  ])("refreshes %s under the store lock", async (_label, expiresAtMs) => {
    const { config, store } = await fixture();
    await store.commit(candidate({ expiresAtMs }));
    const device = authorization();
    const lock = vi.spyOn(store, "withRefreshLock");
    const auth = new AuthClient(config, {
      env: {},
      store,
      authorization: device as never,
      now: () => 100_000,
    });

    await expect(auth.accessToken()).resolves.toBe("refreshed-access");
    expect(lock).toHaveBeenCalledTimes(1);
    expect(device.refresh).toHaveBeenCalledWith("oauth-refresh");
    await expect(store.readOAuth()).resolves.toMatchObject({
      tokens: {
        accessToken: "refreshed-access",
        refreshToken: "rotated-refresh",
      },
    });
  });

  it("reuses credentials refreshed by another process after acquiring the lock", async () => {
    const current: OAuthCredentialRecord = {
      version: 1,
      platformBaseURL: "https://platform.example",
      oauthClientID: "client_intern",
      tokens: {
        accessToken: "expired-access",
        refreshToken: "old-refresh",
        expiresAtMs: 1,
        scope: "profile",
      },
    };
    const newer: OAuthCredentialRecord = {
      ...current,
      tokens: {
        accessToken: "already-refreshed",
        refreshToken: "new-refresh",
        expiresAtMs: 500_000,
        scope: "profile",
      },
    };
    const store = {
      read: vi.fn(async () => ({ kind: "oauth", record: current })),
      withRefreshLock: vi.fn(
        async (
          callback: (record: OAuthCredentialRecord) => Promise<{ result: string }>,
        ) => (await callback(newer)).result,
      ),
      commit: vi.fn(),
    };
    const device = authorization();
    const auth = new AuthClient(loadConfig({ HOME: "/tmp/unused" }), {
      env: {},
      store: store as never,
      authorization: device as never,
      now: () => 100_000,
    });
    await expect(auth.accessToken()).resolves.toBe("already-refreshed");
    expect(device.refresh).not.toHaveBeenCalled();
  });

  it("turns refresh failure into setup guidance without changing the record", async () => {
    const { config, store } = await fixture();
    await store.commit(candidate({ expiresAtMs: 1 }));
    const before = await store.readOAuth();
    const auth = new AuthClient(config, {
      env: {},
      store,
      authorization: authorization({
        refresh: vi.fn(async () => {
          throw new Error("refresh token rejected");
        }),
      }) as never,
      now: () => 100_000,
    });

    await expect(auth.accessToken()).rejects.toThrow("run setup again");
    await expect(store.readOAuth()).resolves.toEqual(before);
  });

  it("aborts an in-flight refresh and releases its credential lock", async () => {
    const { configRoot, config, store } = await fixture();
    await store.commit(candidate({ expiresAtMs: 1 }));
    const refresh = vi.fn(
      async (_refreshToken: string, signal?: AbortSignal) =>
        new Promise<OAuthCandidate>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const auth = new AuthClient(config, {
      env: {},
      store,
      authorization: authorization({ refresh }) as never,
      now: () => 100_000,
    });
    const controller = new AbortController();
    const reason = new Error("organization readiness timed out");
    const pending = auth.accessToken(controller.signal);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(
      (await fs.readdir(configRoot)).filter((entry) => entry.startsWith(".refresh")),
    ).toEqual([]);
  });

  it("commits a new authorization only after TryIntern verifies it", async () => {
    const { config, store } = await fixture();
    const verifier = vi.fn(async () => {});
    const auth = new AuthClient(config, {
      env: {},
      store,
      authorization: authorization() as never,
      verifier,
    });

    await expect(auth.authorize()).resolves.toBe("oauth-access");
    expect(verifier).toHaveBeenCalledWith("oauth-access");
    await expect(store.readOAuth()).resolves.toMatchObject({
      tokens: { accessToken: "oauth-access" },
    });
  });

  it("leaves OAuth and legacy credentials unchanged when verification fails", async () => {
    const { configRoot, config, store } = await fixture();
    await fs.writeFile(path.join(configRoot, "access-token"), "legacy-token\n");
    await store.commit(candidate({ accessToken: "old-oauth" }));
    const before = await fs.readFile(path.join(configRoot, "credentials.json"), "utf8");
    const auth = new AuthClient(config, {
      env: {},
      store,
      authorization: authorization() as never,
      verifier: async () => {
        throw new Error("TryIntern rejected authorization");
      },
    });

    await expect(auth.authorize()).rejects.toThrow("TryIntern rejected authorization");
    await expect(
      fs.readFile(path.join(configRoot, "credentials.json"), "utf8"),
    ).resolves.toBe(before);
    await expect(
      fs.readFile(path.join(configRoot, "access-token"), "utf8"),
    ).resolves.toBe("legacy-token\n");
  });

  it("gives an actionable setup error when no credential exists", async () => {
    const { config, store } = await fixture();
    const auth = new AuthClient(config, {
      env: {},
      store,
      authorization: authorization() as never,
    });
    await expect(auth.hasCredentials()).resolves.toBe(false);
    await expect(auth.accessToken()).rejects.toThrow("run setup again");
  });

  it("preserves the existing explicit-token constructor for MCP callers", async () => {
    const auth = new AuthClient("  explicit-token  ");
    await expect(auth.hasCredentials()).resolves.toBe(true);
    await expect(auth.accessToken()).resolves.toBe("explicit-token");
  });
});
