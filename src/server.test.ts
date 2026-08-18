import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, expect, test } from "vitest";
import type { SiteRuntimeContract } from "./api.js";
import { PACKAGE_VERSION } from "./config.js";
import { buildServer } from "./server.js";

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

async function previewTemporaryDirectories(): Promise<Set<string>> {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  return new Set(
    (await fs.readdir(temporaryRoot))
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
          user: { id: "usr_1", org: "org_1", org_name: "Acme", org_role: "admin" },
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
  const previewTempsBefore = await previewTemporaryDirectories();
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
  expect(localTestResult.test).toMatchObject({
    running: true,
    source: "working-tree",
    validation: { valid: true },
  });
  expect(await (await fetch(localTestResult.test.url)).text()).toBe(
    "uncommitted local preview\n",
  );
  expect(
    await (await fetch(new URL("/untracked.txt", localTestResult.test.url))).text(),
  ).toBe("included untracked edit\n");
  expect((await fetch(new URL("/ignored.txt", localTestResult.test.url))).status).toBe(
    404,
  );
  const previewTempsDuring = await previewTemporaryDirectories();
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
  expect(await (await fetch(refreshedURL)).text()).toBe("refreshed local preview\n");
  const refreshedPreviewTemps = await previewTemporaryDirectories();
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
  await fs.writeFile(
    path.join(structured.workspace.path, "package.json"),
    '{"private":true,"type":"module","dependencies":{"express":"latest"}}\n',
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
  await exec("git", ["add", "package.json", "src/main.js"], {
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
  await fs.writeFile(
    path.join(structured.workspace.path, "package.json"),
    '{"private":true,"type":"module"}\n',
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
  const concurrentTempsBefore = await previewTemporaryDirectories();
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
  expect(await previewTemporaryDirectories()).toEqual(concurrentTempsBefore);

  // Closing stdio stops previews that were not explicitly stopped.
  const finalTempsBefore = await previewTemporaryDirectories();
  const finalTest = await client.callTool({
    name: "intern_test_site",
    arguments: { site: "docs" },
  });
  const finalURL = (finalTest.structuredContent as { test: { url: string } }).test.url;
  expect(await fetch(finalURL)).toMatchObject({ status: 200 });
  const finalTempsDuring = await previewTemporaryDirectories();
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
