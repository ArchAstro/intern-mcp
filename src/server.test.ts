import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, expect, test, vi } from "vitest";
import { InternAPI, InternAPIError, type SiteRuntimeContract } from "./api.js";
import { AuthClient } from "./auth.js";
import { loadConfig, PACKAGE_VERSION } from "./config.js";
import { CredentialStore } from "./credential-store.js";
import { buildServer, prepareInternSite } from "./server.js";

const unprovisionedSession = {
  user: {
    id: "usr_1",
    org: "org_1",
    org_name: "Acme",
    org_role: "admin" as const,
  },
  org: { id: null, slug: "acme", state: "unprovisioned" },
};

const activeSession = {
  ...unprovisionedSession,
  org: { id: "intorg_1", slug: "acme", state: "active" },
};

const failedSession = {
  ...activeSession,
  org: { ...activeSession.org, state: "failed" },
};

const destroyedSession = {
  ...activeSession,
  org: { ...activeSession.org, state: "destroyed" },
};

const provisioningSession = {
  ...activeSession,
  org: { ...activeSession.org, state: "provisioning" },
};

const preparedSite = {
  id: "site_1",
  orgSlug: "acme",
  slug: "docs",
  state: "active",
  siteType: "vite",
  port: 4100,
  url: "https://docs.acme.tryintern.dev",
  gitUrl: "acme@git.intern.dev:docs.git",
};

function readinessClock(
  states: Array<typeof unprovisionedSession | typeof activeSession>,
) {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) throw signal.reason;
      now += milliseconds;
    },
    nextSession: () => states.shift() ?? states.at(-1) ?? unprovisionedSession,
  };
}

test("returns provisioning without preparing a checkout while the organization starts", async () => {
  const clock = readinessClock([]);
  const workspaces = { prepare: vi.fn(), validate: vi.fn() };
  const api = {
    session: vi.fn(async () => unprovisionedSession),
    listSites: vi.fn(async () => []),
    createSite: vi.fn(async () => {
      throw new InternAPIError(409, "org_not_ready", "organization is provisioning");
    }),
  };

  const value = await prepareInternSite(
    api as never,
    workspaces as never,
    { site: "docs", createIfMissing: true, siteType: "vite" },
    clock,
  );

  expect(value).toMatchObject({
    status: "provisioning",
    orgState: "provisioning",
    retryAfterMs: 5_000,
  });
  expect(workspaces.prepare).not.toHaveBeenCalled();
  expect(workspaces.validate).not.toHaveBeenCalled();
});

test("returns ready after an organization becomes active", async () => {
  const clock = readinessClock([unprovisionedSession, activeSession]);
  const api = {
    session: vi.fn(async () => clock.nextSession()),
    listSites: vi.fn(async () => []),
    createSite: vi
      .fn()
      .mockRejectedValueOnce(
        new InternAPIError(409, "org_not_ready", "organization is provisioning"),
      )
      .mockResolvedValueOnce(preparedSite),
    runtimeContract: vi.fn(async () => ({ version: "intern-node-static-v1" })),
  };
  const workspaces = {
    prepare: vi.fn(async () => ({ path: "/tmp/docs" })),
    validate: vi.fn(async () => ({ valid: true })),
  };

  const value = await prepareInternSite(
    api as never,
    workspaces as never,
    { site: "docs", createIfMissing: true, siteType: "vite" },
    clock,
  );

  expect(value).toMatchObject({ status: "ready", site: { slug: "docs" } });
  expect(api.createSite).toHaveBeenCalledTimes(2);
  expect(workspaces.prepare).toHaveBeenCalledOnce();
});

test.each([
  ["failed", failedSession],
  ["destroyed", destroyedSession],
])(
  "triggers one admin retry for a %s organization and later returns ready",
  async (_state, initialSession) => {
    const clock = readinessClock([initialSession, activeSession]);
    const api = {
      session: vi.fn(async () => clock.nextSession()),
      listSites: vi.fn(async () => [preparedSite]),
      createSite: vi.fn(async () => {
        throw new InternAPIError(409, "org_not_ready", "organization is provisioning");
      }),
      runtimeContract: vi.fn(async () => ({ version: "intern-node-static-v1" })),
    };
    const workspaces = {
      prepare: vi.fn(async () => ({ path: "/tmp/docs" })),
      validate: vi.fn(async () => ({ valid: true })),
    };

    const value = await prepareInternSite(
      api as never,
      workspaces as never,
      { site: "docs", createIfMissing: true, siteType: "vite" },
      clock,
    );

    expect(value).toMatchObject({ status: "ready" });
    expect(value).toMatchObject({ site: preparedSite });
    expect(api.createSite).toHaveBeenCalledOnce();
  },
);

test.each([
  ["unprovisioned", unprovisionedSession],
  ["failed", failedSession],
  ["destroyed", destroyedSession],
])(
  "does not claim %s provisioning when the pre-trigger site list exceeds the deadline",
  async (_state, session) => {
    vi.useFakeTimers();
    try {
      const api = {
        session: vi.fn(async () => session),
        listSites: vi.fn(
          async (signal: AbortSignal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        ),
      };
      const pending = prepareInternSite(api as never, {} as never, {
        site: "docs",
        createIfMissing: true,
        siteType: "vite",
      });
      const rejection = expect(pending).rejects.toThrow(
        "organization readiness timed out",
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each([
  ["unprovisioned", unprovisionedSession, []],
  ["failed", failedSession, [preparedSite]],
  ["destroyed", destroyedSession, [preparedSite]],
])(
  "does not claim %s provisioning when the trigger exceeds the deadline",
  async (_state, session, sites) => {
    vi.useFakeTimers();
    try {
      const api = {
        session: vi.fn(async () => session),
        listSites: vi.fn(async () => sites),
        createSite: vi.fn(
          async (_slug: string, _siteType: string, signal: AbortSignal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        ),
      };
      const pending = prepareInternSite(api as never, {} as never, {
        site: "docs",
        createIfMissing: true,
        siteType: "vite",
      });
      const rejection = expect(pending).rejects.toThrow(
        "organization readiness timed out",
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  },
);

test("propagates a member refusal when a failed organization needs an admin retry", async () => {
  const refusal = new InternAPIError(403, "forbidden", "admin role required");
  const api = {
    session: vi.fn(async () => failedSession),
    listSites: vi.fn(async () => [preparedSite]),
    createSite: vi.fn(async () => {
      throw refusal;
    }),
  };

  await expect(
    prepareInternSite(
      api as never,
      {} as never,
      { site: "docs", createIfMissing: true, siteType: "vite" },
      readinessClock([]),
    ),
  ).rejects.toBe(refusal);
  expect(api.createSite).toHaveBeenCalledOnce();
});

test("does not retrigger an organization that is already provisioning", async () => {
  const clock = readinessClock([provisioningSession, activeSession]);
  const api = {
    session: vi.fn(async () => clock.nextSession()),
    listSites: vi.fn(async () => []),
    createSite: vi.fn(async () => preparedSite),
    runtimeContract: vi.fn(async () => ({ version: "intern-node-static-v1" })),
  };

  await expect(
    prepareInternSite(
      api as never,
      {
        prepare: vi.fn(async () => ({ path: "/tmp/docs" })),
        validate: vi.fn(async () => ({ valid: true })),
      } as never,
      { site: "docs", createIfMissing: true, siteType: "vite" },
      clock,
    ),
  ).resolves.toMatchObject({ status: "ready" });
  expect(api.createSite).toHaveBeenCalledOnce();
});

test("bounds the organization-readiness phase", async () => {
  const clock = readinessClock([]);
  const signals: AbortSignal[] = [];
  const api = {
    session: vi.fn(async (signal: AbortSignal) => {
      signals.push(signal);
      return unprovisionedSession;
    }),
    listSites: vi.fn(async (signal: AbortSignal) => {
      signals.push(signal);
      return [];
    }),
    createSite: vi.fn(async (_slug: string, _siteType: string, signal: AbortSignal) => {
      signals.push(signal);
      throw new InternAPIError(409, "org_not_ready", "organization is provisioning");
    }),
  };

  const value = await prepareInternSite(
    api as never,
    { prepare: vi.fn(), validate: vi.fn() } as never,
    { site: "docs", createIfMissing: true, siteType: "vite" },
    clock,
  );

  expect(value).toMatchObject({ status: "provisioning" });
  expect(clock.now()).toBe(20_000);
  expect(new Set(signals).size).toBe(1);
  expect(signals[0]?.aborted).toBe(true);
});

test("propagates forbidden, unrelated preconditions, and service outages", async () => {
  for (const failure of [
    new InternAPIError(403, "forbidden", "forbidden"),
    new InternAPIError(409, "site_not_ready", "site deletion in progress"),
    new InternAPIError(503, "control_unavailable", "control unavailable"),
  ]) {
    const api = {
      session: vi.fn(async () => activeSession),
      listSites: vi.fn(async () => []),
      createSite: vi.fn(async () => {
        throw failure;
      }),
    };
    await expect(
      prepareInternSite(
        api as never,
        {} as never,
        { site: "docs", createIfMissing: true, siteType: "vite" },
        readinessClock([]),
      ),
    ).rejects.toBe(failure);
  }
});

test.each([
  new InternAPIError(403, "forbidden", "forbidden"),
  new InternAPIError(409, "site_not_ready", "site deletion in progress"),
  new InternAPIError(503, "control_unavailable", "control unavailable"),
])(
  "propagates timeout-adjacent structured errors instead of returning provisioning",
  async (failure) => {
    vi.useFakeTimers();
    try {
      let sessionCalls = 0;
      const api = {
        session: vi.fn(async (signal: AbortSignal) => {
          sessionCalls++;
          if (sessionCalls === 1) return unprovisionedSession;
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(failure), { once: true });
          });
        }),
        listSites: vi.fn(async () => []),
        createSite: vi.fn(async () => {
          throw new InternAPIError(
            409,
            "org_not_ready",
            "organization is provisioning",
          );
        }),
      };
      const pending = prepareInternSite(api as never, {} as never, {
        site: "docs",
        createIfMissing: true,
        siteType: "vite",
      });
      const rejection = expect(pending).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(19_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  },
);

test("bounds credential refresh lock contention inside organization readiness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-readiness-auth-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  try {
    const config = loadConfig({
      HOME: root,
      INTERN_CONFIG_ROOT: root,
      INTERN_BASE_URL: "https://tryintern.dev",
      ARCHASTRO_API_URL: "https://platform.example",
      ARCHASTRO_PUBLISHABLE_KEY: "pk_public",
      INTERN_OAUTH_CLIENT_ID: "client_intern",
    });
    const store = new CredentialStore(root, {
      platformBaseURL: config.archAstroBaseURL,
      oauthClientID: config.oauthClientID,
    });
    await store.commit({
      platformBaseURL: config.archAstroBaseURL,
      oauthClientID: config.oauthClientID,
      accessToken: "expired-access",
      refreshToken: "refresh-token",
      expiresAtMs: 1,
      scope: "profile",
    });
    await fs.writeFile(
      path.join(root, "refresh.lock"),
      `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now(), token: "live-owner" })}\n`,
      { mode: 0o600 },
    );
    vi.useFakeTimers();
    const refresh = vi.fn(async () => preparedSite as never);
    const auth = new AuthClient(config, {
      env: {},
      store,
      authorization: { authorize: vi.fn(), refresh } as never,
    });
    const api = new InternAPI(config, auth, vi.fn() as never);
    const pending = prepareInternSite(api, {} as never, {
      site: "docs",
      createIfMissing: true,
      siteType: "vite",
    });
    const rejection = expect(pending).rejects.toThrow(
      "organization readiness timed out",
    );
    for (let attempt = 0; attempt < 50; attempt++) {
      const entries = await fs.readdir(root);
      if (entries.some((entry) => entry.startsWith(".refresh-intent."))) break;
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(20_000);

    await rejection;
    expect(refresh).not.toHaveBeenCalled();
    expect(
      (await fs.readdir(root)).filter((entry) => entry.startsWith(".refresh-intent.")),
    ).toEqual([]);
    await expect(fs.stat(path.join(root, "refresh.lock"))).resolves.toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

test("keeps the final post-active site lookup inside the shared readiness deadline", async () => {
  vi.useFakeTimers();
  try {
    let sessionCalls = 0;
    let listCalls = 0;
    const signals: AbortSignal[] = [];
    const api = {
      session: vi.fn(async () => {
        sessionCalls++;
        if (sessionCalls === 1) return provisioningSession;
        await new Promise((resolve) => setTimeout(resolve, 18_900));
        return activeSession;
      }),
      listSites: vi.fn(async (signal?: AbortSignal) => {
        listCalls++;
        if (signal) signals.push(signal);
        if (listCalls === 1) return [];
        if (!signal) throw new Error("final readiness lookup lost its deadline");
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    };
    const pending = prepareInternSite(api as never, {} as never, {
      site: "docs",
      createIfMissing: true,
      siteType: "vite",
    });
    const completion = expect(pending).resolves.toMatchObject({
      status: "provisioning",
      orgState: "provisioning",
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await completion;
    expect(listCalls).toBe(2);
    expect(new Set(signals).size).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("advertises MCP titles, instructions, field descriptions, and workflow prompts", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(
    {
      hasCredentials: async () => false,
    } as never,
    {
      listSites: async () => [{ slug: "docs" }, { slug: "blog" }],
    } as never,
    {} as never,
  );
  const client = new Client({ name: "intern-contract", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    expect(client.getServerVersion()).toMatchObject({
      name: "intern",
      version: PACKAGE_VERSION,
    });
    expect(client.getInstructions()).toMatch(/intern_prepare_site/);
    expect(client.getInstructions()).toMatch(/never stages or commits/i);
    expect(client.getInstructions()).toContain("default-import Client");
    expect(client.getInstructions()).toContain("Never write globalThis.intern");

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "intern_auth_status",
        "intern_list_sites",
        "intern_prepare_site",
        "intern_site_status",
        "intern_validate_site",
        "intern_test_site",
        "intern_stop_test",
        "intern_publish_site",
      ]),
    );
    expect(toolNames).not.toEqual(
      expect.arrayContaining([
        "intern_login",
        "intern_complete_login",
        "intern_logout",
      ]),
    );
    expect(client.getInstructions()).toContain("INTERN_ACCESS_TOKEN");
    expect(client.getInstructions()).toContain("intern-mcp launch");
    expect(client.getInstructions()).toContain("rerunning setup");
    expect(client.getInstructions()).toContain("https://tryintern.dev/connect");
    for (const tool of tools.tools) expect(tool.title, tool.name).toBeTruthy();
    const prepare = tools.tools.find((tool) => tool.name === "intern_prepare_site");
    expect(prepare?.inputSchema).toMatchObject({
      properties: {
        site: { description: expect.stringMatching(/slug/i) },
        createIfMissing: { description: expect.stringMatching(/create/i) },
      },
    });
    expect(prepare?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });

    const prompts = await client.listPrompts();
    const promptNames = prompts.prompts.map((prompt) => prompt.name);
    expect(promptNames).toEqual(expect.arrayContaining(["intern_work_on_site"]));
    expect(promptNames).not.toContain("intern_sign_in");
    const workflow = await client.getPrompt({
      name: "intern_work_on_site",
      arguments: { site: "docs" },
    });
    expect(workflow.messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining('intern_prepare_site with site "docs"'),
    });

    const resources = await client.listResources();
    expect(
      resources.resources.find((resource) => resource.uri === "intern://session")
        ?.description,
    ).toMatch(/does not include credentials/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("reports a configured but rejected access token as unauthorized", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(
    { hasCredentials: async () => true } as never,
    {
      session: async () => {
        throw new Error("AUTH_REQUIRED: invalid_token");
      },
    } as never,
    {} as never,
  );
  const client = new Client({ name: "intern-auth-contract", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const status = await client.callTool({
      name: "intern_auth_status",
      arguments: {},
    });
    expect(status.structuredContent).toEqual({
      authorized: false,
      setupURL: "https://tryintern.dev/connect",
    });
  } finally {
    await client.close();
    await server.close();
  }
});

async function previewTemporaryDirectories(
  temporaryRoot: string,
): Promise<Set<string>> {
  const entries = await fs
    .readdir(temporaryRoot)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  return new Set(
    entries
      .filter((name) => name.startsWith("intern-mcp-test-"))
      .map((name) => path.join(temporaryRoot, name)),
  );
}

test("an authorized MCP client prepares and publishes an Intern checkout over stdio", async () => {
  // Set up an Intern-shaped HTTP boundary and a real bare Git repository.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-stdio-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "docs.git");
  const seed = path.join(root, "seed");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["clone", remote, seed]);
  await exec("git", ["config", "user.email", "proof@localhost"], { cwd: seed });
  await exec("git", ["config", "user.name", "Proof"], { cwd: seed });
  const runtimeContract = JSON.parse(
    await fs.readFile(
      fileURLToPath(new URL("../test/fixtures/runtime-contract.json", import.meta.url)),
      "utf8",
    ),
  ) as SiteRuntimeContract;
  const launcher = runtimeContract.protectedFiles["run-site.sh"];
  await fs.writeFile(path.join(seed, "index.html"), "before\n");
  await fs.writeFile(
    path.join(seed, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  await fs.writeFile(
    path.join(seed, "server.mjs"),
    runtimeContract.protectedFiles["server.mjs"].replaceAll("{{PORT}}", "4100"),
  );
  await fs.writeFile(path.join(seed, "run-site.sh"), launcher, { mode: 0o750 });
  await fs.mkdir(path.join(seed, "src"));
  await fs.writeFile(
    path.join(seed, "src/main.js"),
    "document.body.dataset.ready = 'true';\n",
  );
  await exec("git", ["add", "."], { cwd: seed });
  await exec("git", ["commit", "-m", "seed"], { cwd: seed });
  await exec("git", ["push", "origin", "HEAD:main"], { cwd: seed });
  await exec("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });

  const site = {
    id: "site_1",
    orgSlug: "acme",
    slug: "docs",
    state: "active",
    siteType: "vite",
    port: 4100,
    url: "https://docs.acme.sites.intern.dev",
    gitUrl: remote,
  };
  let backendRequestCount = 0;
  let blockedSiteList: { started(): void; wait: Promise<void> } | undefined;
  const backend = http.createServer(async (request, response) => {
    backendRequestCount += 1;
    if (request.headers.authorization !== "Bearer authorized-proof-token") {
      response
        .writeHead(401, { "content-type": "application/json" })
        .end('{"error":"unauthorized"}');
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/mcp/session")
      response.end(
        JSON.stringify({
          user: {
            id: "usr_1",
            org: "org_1",
            org_name: "Acme",
            org_role: "admin",
            email: "ada@example.com",
            name: "Ada",
            profile_picture: {
              url: "https://images.test/ada.png",
              mime_type: "image/png",
              width: 128,
              height: 128,
            },
          },
          org: { id: "intorg_1", slug: "acme", state: "active" },
        }),
      );
    else if (request.url === "/api/v1/mcp/sites") {
      const blocked = blockedSiteList;
      blockedSiteList = undefined;
      if (blocked) {
        blocked.started();
        await blocked.wait;
      }
      response.end(JSON.stringify({ sites: [site] }));
    } else if (request.url === "/api/v1/mcp/runtime-contract")
      response.end(JSON.stringify({ contract: runtimeContract }));
    else response.writeHead(404).end('{"error":"not_found"}');
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => backend.close(() => resolve())));
  const address = backend.address();
  if (!address || typeof address === "string")
    throw new Error("test backend did not bind TCP");

  const previewTmp = await fs.realpath(
    await fs.mkdtemp(path.join(root, "preview-tmp-")),
  );

  // Cross the real stdio MCP boundary and obtain the guarded checkout path.
  const entry = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist/index.js",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "serve"],
    env: {
      ...process.env,
      TMPDIR: previewTmp,
      INTERN_BASE_URL: `http://127.0.0.1:${address.port}`,
      INTERN_ACCESS_TOKEN: "authorized-proof-token",
      INTERN_WORKSPACE_ROOT: path.join(root, "workspaces"),
      INTERN_CONFIG_ROOT: path.join(root, "config"),
    },
  });
  const client = new Client({ name: "intern-proof", version: "1.0.0" });
  await client.connect(transport);
  let clientOpen = true;
  cleanups.push(async () => {
    if (clientOpen) await client.close();
  });

  const listed = await client.listTools();
  expect(listed.tools.map((tool) => tool.name)).toContain("intern_prepare_site");
  const prepared = await client.callTool({
    name: "intern_prepare_site",
    arguments: { site: "docs" },
  });
  const structured = prepared.structuredContent as {
    workspace: { path: string };
    validation: { valid: boolean };
  };
  expect(structured.workspace.path).toBe(path.join(root, "workspaces", "acme", "docs"));
  expect(structured.workspace).toMatchObject({ dirty: true });
  const preparedPackage = JSON.parse(
    await fs.readFile(path.join(structured.workspace.path, "package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  expect(preparedPackage.devDependencies?.["@archastro/intern-sdk"]).toMatch(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  );
  const preparedLock = JSON.parse(
    await fs.readFile(
      path.join(structured.workspace.path, "package-lock.json"),
      "utf8",
    ),
  ) as { name?: string };
  expect(preparedLock.name).toBe("docs");
  await expect(
    fs.stat(path.join(structured.workspace.path, "node_modules")),
  ).rejects.toThrow();
  expect(structured.validation.valid, JSON.stringify(prepared.structuredContent)).toBe(
    true,
  );
  const resources = await client.listResources();
  expect(resources.resources.map((resource) => resource.uri)).toContain(
    "intern://sites/docs/workspace",
  );
  const workspaceResource = await client.readResource({
    uri: "intern://sites/docs/workspace",
  });
  expect(workspaceResource.contents[0]).toMatchObject({
    uri: "intern://sites/docs/workspace",
    mimeType: "application/json",
  });

  // Test tracked and untracked model edits without leaking ignored files or mutating the checkout.
  const previewTempsBefore = await previewTemporaryDirectories(previewTmp);
  await fs.writeFile(
    path.join(structured.workspace.path, "index.html"),
    "uncommitted local preview\n",
  );
  await fs.writeFile(
    path.join(structured.workspace.path, ".gitignore"),
    "ignored.txt\n",
  );
  await fs.writeFile(
    path.join(structured.workspace.path, "untracked.txt"),
    "included untracked edit\n",
  );
  await fs.writeFile(
    path.join(structured.workspace.path, "ignored.txt"),
    "must not enter preview\n",
  );
  const statusBeforeTest = await client.callTool({
    name: "intern_site_status",
    arguments: { site: "docs" },
  });
  const changesBeforeTest = (
    statusBeforeTest.structuredContent as { workspace: { changes: string[] } }
  ).workspace.changes;
  const localTest = await client.callTool({
    name: "intern_test_site",
    arguments: { site: "docs" },
  });
  const localTestResult = localTest.structuredContent as {
    test: {
      running: boolean;
      url: string;
      source: string;
      validation: { valid: boolean };
    };
  };
  expect(localTestResult.test, JSON.stringify(localTestResult.test)).toMatchObject({
    running: true,
    source: "working-tree",
    validation: { valid: true },
  });
  const previewHTML = await (await fetch(localTestResult.test.url)).text();
  expect(previewHTML).toContain('<script src="/.intern/runtime.js"></script>');
  expect(previewHTML).toContain("uncommitted local preview\n");
  const runtimeScript = await (
    await fetch(new URL("/.intern/runtime.js", localTestResult.test.url))
  ).text();
  expect(runtimeScript).toContain("resolveRuntime");
  expect(runtimeScript).toContain("plugins:Object.freeze({me})");
  const initialMe = await (
    await fetch(new URL("/.intern/api/me", localTestResult.test.url))
  ).json();
  expect(initialMe).toMatchObject({
    id: "usr_1",
    email: "ada@example.com",
    name: "Ada",
    profilePicture: {
      url: "https://images.test/ada.png",
      contentType: "image/png",
      width: 128,
      height: 128,
    },
    viewer: { userId: "usr_1", orgId: "org_1", orgSlug: "acme", orgRole: "admin" },
  });
  const updatedMe = await (
    await fetch(new URL("/.intern/api/me", localTestResult.test.url), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ada Lovelace",
        profilePicture: {
          data: "AP8=",
          contentType: "image/png",
          filename: "ada.png",
        },
      }),
    })
  ).json();
  expect(updatedMe).toMatchObject({
    name: "Ada Lovelace",
    profilePicture: {
      url: "data:image/png;base64,AP8=",
      contentType: "image/png",
    },
  });
  expect(
    await (await fetch(new URL("/untracked.txt", localTestResult.test.url))).text(),
  ).toBe("included untracked edit\n");
  expect((await fetch(new URL("/ignored.txt", localTestResult.test.url))).status).toBe(
    404,
  );
  const previewTempsDuring = await previewTemporaryDirectories(previewTmp);
  const createdPreviewTemps = [...previewTempsDuring].filter(
    (directory) => !previewTempsBefore.has(directory),
  );
  expect(createdPreviewTemps).toHaveLength(1);

  // Calling the tool again atomically replaces the old snapshot with the latest bytes.
  await fs.writeFile(
    path.join(structured.workspace.path, "index.html"),
    "refreshed local preview\n",
  );
  const refreshed = await client.callTool({
    name: "intern_test_site",
    arguments: { site: "docs" },
  });
  const refreshedURL = (refreshed.structuredContent as { test: { url: string } }).test
    .url;
  const refreshedHTML = await (await fetch(refreshedURL)).text();
  expect(refreshedHTML).toContain('<script src="/.intern/runtime.js"></script>');
  expect(refreshedHTML).toContain("refreshed local preview\n");
  expect(
    await (await fetch(new URL("/.intern/api/me", refreshedURL))).json(),
  ).toMatchObject({
    name: "Ada",
    profilePicture: { url: "https://images.test/ada.png" },
  });
  const refreshedPreviewTemps = await previewTemporaryDirectories(previewTmp);
  const refreshedCreatedTemps = [...refreshedPreviewTemps].filter(
    (directory) => !previewTempsBefore.has(directory),
  );
  expect(refreshedCreatedTemps).toHaveLength(1);
  expect(
    await fs.readFile(path.join(structured.workspace.path, "index.html"), "utf8"),
  ).toBe("refreshed local preview\n");
  expect(
    await fs.readFile(path.join(structured.workspace.path, "untracked.txt"), "utf8"),
  ).toBe("included untracked edit\n");
  expect(
    await fs.readFile(path.join(structured.workspace.path, "ignored.txt"), "utf8"),
  ).toBe("must not enter preview\n");
  const statusAfterTest = await client.callTool({
    name: "intern_site_status",
    arguments: { site: "docs" },
  });
  expect(
    (statusAfterTest.structuredContent as { workspace: { changes: string[] } })
      .workspace.changes,
  ).toEqual(changesBeforeTest);
  const requestsBeforeStop = backendRequestCount;
  const stopped = await client.callTool({
    name: "intern_stop_test",
    arguments: { site: "docs" },
  });
  expect(stopped.structuredContent).toMatchObject({ stopped: true });
  expect(backendRequestCount).toBe(requestsBeforeStop);
  await expect(
    fetch(refreshedURL, { signal: AbortSignal.timeout(1_000) }),
  ).rejects.toThrow();
  for (const directory of new Set([...createdPreviewTemps, ...refreshedCreatedTemps]))
    await expect(fs.stat(directory)).rejects.toThrow();
  await exec("git", ["restore", "index.html"], { cwd: structured.workspace.path });
  await fs.rm(path.join(structured.workspace.path, ".gitignore"));
  await fs.rm(path.join(structured.workspace.path, "untracked.txt"));
  await fs.rm(path.join(structured.workspace.path, "ignored.txt"));

  // The coding host first makes a committed change that the backend cannot run.
  const invalidPackage = {
    ...preparedPackage,
    dependencies: { express: "latest" },
  };
  await fs.writeFile(
    path.join(structured.workspace.path, "package.json"),
    `${JSON.stringify(invalidPackage)}\n`,
  );
  await fs.writeFile(
    path.join(structured.workspace.path, "src/main.js"),
    "export const = broken;\n",
  );
  await exec("git", ["config", "user.email", "proof@localhost"], {
    cwd: structured.workspace.path,
  });
  await exec("git", ["config", "user.name", "Proof"], {
    cwd: structured.workspace.path,
  });
  await exec("git", ["add", "package.json", "package-lock.json", "src/main.js"], {
    cwd: structured.workspace.path,
  });
  await exec("git", ["commit", "-m", "unsupported runtime dependency"], {
    cwd: structured.workspace.path,
  });
  const invalid = await client.callTool({
    name: "intern_validate_site",
    arguments: { site: "docs" },
  });
  expect(invalid.structuredContent).toMatchObject({ validation: { valid: false } });
  const invalidIssues = (
    invalid.structuredContent as { validation: { issues: Array<{ code: string }> } }
  ).validation.issues;
  expect(invalidIssues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "package_install_unsupported" }),
      expect.objectContaining({ code: "javascript_syntax_error" }),
    ]),
  );
  const refused = await client.callTool({
    name: "intern_publish_site",
    arguments: { site: "docs" },
  });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("VALIDATION_FAILED");
  const rejectedRemotePackage = await exec("git", [
    `--git-dir=${remote}`,
    "show",
    "main:package.json",
  ]);
  expect(rejectedRemotePackage.stdout).toBe('{"private":true,"type":"module"}\n');

  // The model repairs the repository, validates it, and commits the supported page edit.
  const { dependencies: _removedDependencies, ...supportedPackage } = invalidPackage;
  void _removedDependencies;
  await fs.writeFile(
    path.join(structured.workspace.path, "package.json"),
    `${JSON.stringify(supportedPackage)}\n`,
  );
  await fs.writeFile(
    path.join(structured.workspace.path, "src/main.js"),
    "document.body.dataset.ready = 'published';\n",
  );
  await fs.writeFile(
    path.join(structured.workspace.path, "index.html"),
    "published through MCP\n",
  );
  await exec("git", ["add", "package.json", "index.html", "src/main.js"], {
    cwd: structured.workspace.path,
  });
  await exec("git", ["commit", "-m", "publish supported site"], {
    cwd: structured.workspace.path,
  });
  const valid = await client.callTool({
    name: "intern_validate_site",
    arguments: { site: "docs" },
  });
  expect(valid.structuredContent).toMatchObject({
    validation: {
      valid: true,
      checks: { files: true, package: true, syntax: true, startup: true, http: true },
    },
  });
  const published = await client.callTool({
    name: "intern_publish_site",
    arguments: { site: "docs" },
  });
  expect(published.structuredContent).toMatchObject({ validation: { valid: true } });

  // Observe the published commit at the real Git boundary.
  const observed = await exec("git", [
    `--git-dir=${remote}`,
    "show",
    "main:index.html",
  ]);
  expect(observed.stdout).toBe("published through MCP\n");

  // A stop arriving while preview authorization is in flight forms a barrier and leaves no orphan.
  let markSiteListStarted = () => {};
  const siteListStarted = new Promise<void>((resolve) => {
    markSiteListStarted = resolve;
  });
  let releaseSiteList = () => {};
  const siteListWait = new Promise<void>((resolve) => {
    releaseSiteList = resolve;
  });
  blockedSiteList = { started: markSiteListStarted, wait: siteListWait };
  const concurrentTempsBefore = await previewTemporaryDirectories(previewTmp);
  const concurrentTestPromise = client.callTool({
    name: "intern_test_site",
    arguments: { site: "docs" },
  });
  await siteListStarted;
  const concurrentStopPromise = client.callTool({
    name: "intern_stop_test",
    arguments: { site: "docs" },
  });
  releaseSiteList();
  const [concurrentTest, concurrentStop] = await Promise.all([
    concurrentTestPromise,
    concurrentStopPromise,
  ]);
  const concurrentURL = (concurrentTest.structuredContent as { test: { url: string } })
    .test.url;
  expect(concurrentStop.structuredContent).toMatchObject({ stopped: true });
  await expect(
    fetch(concurrentURL, { signal: AbortSignal.timeout(1_000) }),
  ).rejects.toThrow();
  const leftoverPreviewTemps = [
    ...(await previewTemporaryDirectories(previewTmp)),
  ].filter((directory) => !concurrentTempsBefore.has(directory));
  expect(leftoverPreviewTemps).toEqual([]);

  // Closing stdio stops previews that were not explicitly stopped.
  const finalTempsBefore = await previewTemporaryDirectories(previewTmp);
  const finalTest = await client.callTool({
    name: "intern_test_site",
    arguments: { site: "docs" },
  });
  const finalURL = (finalTest.structuredContent as { test: { url: string } }).test.url;
  expect(await fetch(finalURL)).toMatchObject({ status: 200 });
  const finalTempsDuring = await previewTemporaryDirectories(previewTmp);
  const finalCreatedTemps = [...finalTempsDuring].filter(
    (directory) => !finalTempsBefore.has(directory),
  );
  expect(finalCreatedTemps).toHaveLength(1);
  await client.close();
  clientOpen = false;
  await expect(
    fetch(finalURL, { signal: AbortSignal.timeout(1_000) }),
  ).rejects.toThrow();
  for (const directory of finalCreatedTemps)
    await expect(fs.stat(directory)).rejects.toThrow();
}, 30_000);
