import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialStore, type OAuthCredentialRecord } from "./credential-store.js";

const exec = promisify(execFile);
const roots: string[] = [];
const binding = {
  platformBaseURL: "https://platform.example",
  oauthClientID: "client_intern",
};

async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "intern-credentials-"));
  roots.push(value);
  return value;
}

function record(overrides: Partial<OAuthCredentialRecord> = {}): OAuthCredentialRecord {
  return {
    version: 1,
    platformBaseURL: binding.platformBaseURL,
    oauthClientID: binding.oauthClientID,
    tokens: {
      accessToken: "access-one",
      refreshToken: "refresh-one",
      expiresAtMs: 1_000_000,
      scope: "profile",
    },
    ...overrides,
  };
}

function commitRecord(
  store: CredentialStore,
  value: OAuthCredentialRecord,
): Promise<void> {
  return store.commit({
    platformBaseURL: value.platformBaseURL,
    oauthClientID: value.oauthClientID,
    accessToken: value.tokens.accessToken,
    refreshToken: value.tokens.refreshToken,
    expiresAtMs: value.tokens.expiresAtMs,
    scope: value.tokens.scope,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true })));
});

describe("CredentialStore", () => {
  it("atomically writes the versioned schema with private permissions", async () => {
    const configRoot = path.join(await root(), "nested", "intern");
    const store = new CredentialStore(configRoot, binding);
    await store.commit({
      ...binding,
      accessToken: "access-one",
      refreshToken: "refresh-one",
      expiresAtMs: 1_000_000,
      scope: "profile",
    });

    expect(
      JSON.parse(await fs.readFile(path.join(configRoot, "credentials.json"), "utf8")),
    ).toEqual(record());
    expect((await fs.stat(configRoot)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(configRoot, "credentials.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(await fs.readdir(configRoot)).toEqual(["credentials.json"]);
  });

  it("cleans up its temporary file when rename fails", async () => {
    const configRoot = await root();
    const store = new CredentialStore(configRoot, binding, {
      rename: async () => {
        throw new Error("disk refused rename");
      },
    });
    await expect(
      store.commit({
        ...binding,
        accessToken: "access-one",
        refreshToken: "refresh-one",
        expiresAtMs: 1_000_000,
        scope: "profile",
      }),
    ).rejects.toThrow("disk refused rename");
    expect(await fs.readdir(configRoot)).toEqual([]);
  });

  it("makes atomic rename the final fallible credential-write operation", async () => {
    const configRoot = await root();
    const destination = path.join(configRoot, "credentials.json");
    const replacement = record({
      tokens: {
        accessToken: "replacement-access",
        refreshToken: "replacement-refresh",
        expiresAtMs: 2_000_000,
        scope: "profile",
      },
    });
    await commitRecord(new CredentialStore(configRoot, binding), record());
    const operations: string[] = [];
    const store = new CredentialStore(configRoot, binding, {
      chmod: async (file, mode) => {
        operations.push(file === destination ? "chmod-destination" : "chmod-temporary");
        if (file === destination) throw new Error("post-rename chmod is unsafe");
        await fs.chmod(file, mode);
      },
      rename: async (from, to) => {
        operations.push("rename");
        await fs.rename(from, to);
      },
    });

    await commitRecord(store, replacement);

    expect(operations).toEqual(["chmod-temporary", "rename"]);
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
    await expect(store.readOAuth()).resolves.toEqual(replacement);
  });

  it.each([
    ["not-json", "corrupt"],
    [JSON.stringify({ version: 1 }), "corrupt"],
    [
      JSON.stringify(record({ platformBaseURL: "https://other.example" })),
      "different Platform",
    ],
    [
      JSON.stringify(record({ oauthClientID: "different-client" })),
      "different OAuth client",
    ],
  ])(
    "rejects unusable OAuth credentials with setup guidance",
    async (contents, reason) => {
      const configRoot = await root();
      await fs.writeFile(path.join(configRoot, "credentials.json"), contents);
      const store = new CredentialStore(configRoot, binding);
      await expect(store.read()).rejects.toThrow(reason);
      await expect(store.read()).rejects.toThrow("run setup again");
    },
  );

  it("uses legacy only when OAuth credentials are absent and leaves legacy untouched", async () => {
    const configRoot = await root();
    const legacyFile = path.join(configRoot, "access-token");
    await fs.writeFile(legacyFile, "legacy-token\n");
    const store = new CredentialStore(configRoot, binding);

    await expect(store.read()).resolves.toEqual({
      kind: "legacy",
      accessToken: "legacy-token",
    });
    await store.commit({
      ...binding,
      accessToken: "oauth-token",
      refreshToken: "refresh-token",
      expiresAtMs: 1_000_000,
      scope: "profile",
    });
    await expect(store.read()).resolves.toMatchObject({
      kind: "oauth",
      record: { tokens: { accessToken: "oauth-token" } },
    });
    await expect(fs.readFile(legacyFile, "utf8")).resolves.toBe("legacy-token\n");
  });

  it.each([
    ["valid", `${JSON.stringify(record())}\n`],
    ["corrupt", "not-json\n"],
  ])(
    "atomically replaces %s OAuth credentials with a verified manual token",
    async (_kind, oauthContents) => {
      const configRoot = await root();
      await fs.writeFile(path.join(configRoot, "credentials.json"), oauthContents, {
        mode: 0o600,
      });
      await fs.writeFile(path.join(configRoot, "access-token"), "old-legacy\n", {
        mode: 0o600,
      });
      const store = new CredentialStore(configRoot, binding);

      await store.replaceWithLegacy("verified-manual-token");

      await expect(store.read()).resolves.toEqual({
        kind: "legacy",
        accessToken: "verified-manual-token",
      });
      await expect(
        fs.stat(path.join(configRoot, "credentials.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.stat(path.join(configRoot, "access-token"))).mode & 0o777).toBe(
        0o600,
      );
    },
  );

  it("preserves both prior credential formats when manual replacement cannot retire OAuth", async () => {
    const configRoot = await root();
    const oauthFile = path.join(configRoot, "credentials.json");
    const legacyFile = path.join(configRoot, "access-token");
    const oauthContents = `${JSON.stringify(record())}\n`;
    await fs.writeFile(oauthFile, oauthContents, { mode: 0o600 });
    await fs.writeFile(legacyFile, "old-legacy\n", { mode: 0o600 });
    const store = new CredentialStore(configRoot, binding, {
      remove: async (file, options) => {
        if (file === oauthFile) throw new Error("OAuth removal failed");
        await fs.rm(file, options);
      },
    });

    await expect(store.replaceWithLegacy("new-manual")).rejects.toThrow(
      "OAuth removal failed",
    );

    await expect(fs.readFile(oauthFile, "utf8")).resolves.toBe(oauthContents);
    await expect(fs.readFile(legacyFile, "utf8")).resolves.toBe("old-legacy\n");
    await expect(store.read()).resolves.toMatchObject({ kind: "oauth" });
    expect((await fs.readdir(configRoot)).sort()).toEqual([
      "access-token",
      "credentials.json",
    ]);
  });

  it("waits in 100ms intervals for a live refresh owner and never steals by age", async () => {
    const configRoot = await root();
    await fs.writeFile(
      path.join(configRoot, "refresh.lock"),
      JSON.stringify({
        pid: 4242,
        createdAtMs: -1_000_000,
        token: "live-owner",
      }),
    );
    let now = 0;
    const sleeps: number[] = [];
    const store = new CredentialStore(configRoot, binding, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      isProcessAlive: (pid) => pid === 4242 || pid === process.pid,
    });

    await expect(
      store.withRefreshLock(async () => ({ result: "unreachable" })),
    ).rejects.toThrow("timed out waiting for credential refresh");
    expect(sleeps).toHaveLength(300);
    expect(new Set(sleeps)).toEqual(new Set([100]));
  });

  it("removes a lock only when its recorded PID is no longer alive", async () => {
    const configRoot = await root();
    let now = 5_000;
    const store = new CredentialStore(configRoot, binding, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      isProcessAlive: () => false,
    });
    await store.commit({
      ...binding,
      accessToken: "access-one",
      refreshToken: "refresh-one",
      expiresAtMs: 1,
      scope: "profile",
    });
    await fs.writeFile(
      path.join(configRoot, "refresh.lock"),
      JSON.stringify({ pid: 999_999, createdAtMs: 0, token: "dead-owner" }),
    );

    await expect(
      store.withRefreshLock(async (current) => ({
        result: current.tokens.accessToken,
      })),
    ).resolves.toBe("access-one");
    await expect(fs.stat(path.join(configRoot, "refresh.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves the previous record when refresh or replacement write fails", async () => {
    const callbackRoot = await root();
    const callbackStore = new CredentialStore(callbackRoot, binding);
    await commitRecord(callbackStore, record());
    await expect(
      callbackStore.withRefreshLock(async () => {
        throw new Error("refresh failed");
      }),
    ).rejects.toThrow("refresh failed");
    await expect(callbackStore.readOAuth()).resolves.toEqual(record());

    const writeRoot = await root();
    await commitRecord(new CredentialStore(writeRoot, binding), record());
    const writeStore = new CredentialStore(writeRoot, binding, {
      rename: async (from, to) => {
        if (to === path.join(writeRoot, "credentials.json")) {
          throw new Error("replacement failed");
        }
        await fs.rename(from, to);
      },
    });
    await expect(
      writeStore.withRefreshLock(async () => ({
        result: "new-token",
        record: record({
          tokens: {
            accessToken: "new-token",
            refreshToken: "new-refresh",
            expiresAtMs: 2_000_000,
            scope: "profile",
          },
        }),
      })),
    ).rejects.toThrow("replacement failed");
    await expect(writeStore.readOAuth()).resolves.toEqual(record());
  });

  it("rejects an issuer-mismatched replacement while preserving the record", async () => {
    const configRoot = await root();
    const store = new CredentialStore(configRoot, binding);
    await commitRecord(store, record());

    await expect(
      store.withRefreshLock(async () => ({
        result: "wrong-token",
        record: record({ platformBaseURL: "https://other.example" }),
      })),
    ).rejects.toThrow("different Platform");
    await expect(store.readOAuth()).resolves.toEqual(record());
  });

  it("release never removes a lock instance it does not own", async () => {
    const configRoot = await root();
    const lockFile = path.join(configRoot, "refresh.lock");
    const displaced = path.join(configRoot, "displaced-owner");
    const successor = {
      pid: process.pid,
      createdAtMs: Date.now(),
      token: "successor-owner",
    };
    const store = new CredentialStore(configRoot, binding);
    await commitRecord(store, record());

    await store.withRefreshLock(async (current) => {
      await fs.rename(lockFile, displaced);
      await fs.writeFile(lockFile, `${JSON.stringify(successor)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      return { result: current.tokens.accessToken };
    });

    await expect(fs.readFile(lockFile, "utf8")).resolves.toBe(
      `${JSON.stringify(successor)}\n`,
    );
  });

  it.each(["browser-oauth", "manual-legacy"] as const)(
    "serializes an in-flight old refresh before %s setup replacement",
    async (replacementKind) => {
      const configRoot = await root();
      const coordinationRoot = path.join(configRoot, "coordination");
      await fs.mkdir(coordinationRoot);
      const store = new CredentialStore(configRoot, binding);
      await commitRecord(store, record());
      const source = await fs.readFile(
        new URL("./credential-store.ts", import.meta.url),
        "utf8",
      );
      const compiledFile = path.join(configRoot, "credential-store.mjs");
      await fs.writeFile(
        compiledFile,
        ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ES2022,
          },
        }).outputText,
      );
      const moduleURL = pathToFileURL(compiledFile).href;
      const refreshScript = String.raw`
        import fs from "node:fs/promises";
        import path from "node:path";
        import { CredentialStore } from ${JSON.stringify(moduleURL)};
        const [root, coordination] = process.argv.slice(1);
        const store = new CredentialStore(root, ${JSON.stringify(binding)});
        const result = await store.withRefreshLock(async (current) => {
          await fs.writeFile(path.join(coordination, "refresh-started"), "started\n", { flag: "wx" });
          while (!(await fs.stat(path.join(coordination, "release-refresh")).then(() => true).catch(() => false))) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return {
            result: "old-refresh-result",
            record: {
              ...current,
              tokens: {
                ...current.tokens,
                accessToken: "old-refreshed-access",
                refreshToken: "old-refreshed-token",
              },
            },
          };
        });
        process.stdout.write(result);
      `;
      const replacementScript = String.raw`
        import { CredentialStore } from ${JSON.stringify(moduleURL)};
        const [root, kind] = process.argv.slice(1);
        const store = new CredentialStore(root, ${JSON.stringify(binding)});
        if (kind === "browser-oauth") {
          await store.commit({
            ...${JSON.stringify(binding)},
            accessToken: "new-browser-access",
            refreshToken: "new-browser-refresh",
            expiresAtMs: 9000000,
            scope: "profile",
          });
        } else {
          await store.replaceWithLegacy("new-manual-access");
        }
        process.stdout.write("replacement-complete");
      `;

      const refresh = exec(process.execPath, [
        "--input-type=module",
        "--eval",
        refreshScript,
        configRoot,
        coordinationRoot,
      ]);
      await waitForFile(path.join(coordinationRoot, "refresh-started"));
      const replacement = exec(process.execPath, [
        "--input-type=module",
        "--eval",
        replacementScript,
        configRoot,
        replacementKind,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.writeFile(path.join(coordinationRoot, "release-refresh"), "release\n");

      await expect(refresh).resolves.toMatchObject({
        stdout: "old-refresh-result",
      });
      await expect(replacement).resolves.toMatchObject({
        stdout: "replacement-complete",
      });
      if (replacementKind === "browser-oauth") {
        await expect(store.read()).resolves.toMatchObject({
          kind: "oauth",
          record: { tokens: { accessToken: "new-browser-access" } },
        });
      } else {
        await expect(store.read()).resolves.toEqual({
          kind: "legacy",
          accessToken: "new-manual-access",
        });
      }
      expect(
        (await fs.readdir(configRoot)).filter((entry) => entry.startsWith(".refresh")),
      ).toEqual([]);
    },
    15_000,
  );

  it.each(["absent", "dead", "malformed"])(
    "serializes refresh across child processes when the initial lock is %s",
    async (initialLock) => {
      const configRoot = await root();
      const invocationRoot = path.join(configRoot, "refresh-invocations");
      const store = new CredentialStore(configRoot, binding);
      await commitRecord(
        store,
        record({ tokens: { ...record().tokens, expiresAtMs: 1 } }),
      );
      await fs.mkdir(invocationRoot);
      if (initialLock === "dead") {
        await fs.writeFile(
          path.join(configRoot, "refresh.lock"),
          `${JSON.stringify({ pid: 2_147_483_647, createdAtMs: 0, token: "dead-initial-owner" })}\n`,
        );
      } else if (initialLock === "malformed") {
        await fs.writeFile(path.join(configRoot, "refresh.lock"), "{");
      }
      const source = await fs.readFile(
        new URL("./credential-store.ts", import.meta.url),
        "utf8",
      );
      const compiledFile = path.join(configRoot, "credential-store.mjs");
      await fs.writeFile(
        compiledFile,
        ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ES2022,
          },
        }).outputText,
      );
      const moduleURL = pathToFileURL(compiledFile).href;
      const script = String.raw`
      import { randomUUID } from "node:crypto";
      import fs from "node:fs/promises";
      import path from "node:path";
      import { CredentialStore } from ${JSON.stringify(moduleURL)};
      const [root, invocations] = process.argv.slice(1);
      let logicalNow = Date.now();
      const store = new CredentialStore(root, ${JSON.stringify(binding)}, {
        now: () => logicalNow,
        sleep: async (milliseconds) => {
          logicalNow += milliseconds;
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
      });
      const token = await store.withRefreshLock(async (current) => {
        if (current.tokens.expiresAtMs > Date.now()) {
          return { result: current.tokens.accessToken };
        }
        await fs.writeFile(path.join(invocations, String(process.pid) + "-" + randomUUID()), "invoked\n", {
          flag: "wx",
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        const next = {
          ...current,
          tokens: { ...current.tokens, accessToken: "refreshed", refreshToken: "rotated", expiresAtMs: Date.now() + 60000 },
        };
        return { result: next.tokens.accessToken, record: next };
      });
      process.stdout.write(token);
    `;

      const children = await Promise.all([
        exec(process.execPath, [
          "--input-type=module",
          "--eval",
          script,
          configRoot,
          invocationRoot,
        ]),
        exec(process.execPath, [
          "--input-type=module",
          "--eval",
          script,
          configRoot,
          invocationRoot,
        ]),
      ]);
      expect(children.map(({ stdout }) => stdout)).toEqual(["refreshed", "refreshed"]);
      expect(await fs.readdir(invocationRoot)).toHaveLength(1);
      expect(
        (await fs.readdir(configRoot)).filter((entry) => entry.startsWith(".refresh")),
      ).toEqual([]);
    },
  );
});

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      await fs
        .stat(file)
        .then(() => true)
        .catch(() => false)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}
