import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-harnesses-"));
const packDirectory = path.join(temporary, "package");
const publicRegistry = "https://registry.npmjs.org";
const publishableKey = "pk_harness_public";
const oauthClientID = "cc_harness";
const manualAccessToken = "harness-manual-access-token";
const responseSecrets = ["harness-response-cookie", "harness-private-header"];
const retainedOutput = [];
const grants = new Map();
const activeAccessTokens = new Map();
const validRefreshTokens = new Map();
const issuedOAuthTokens = new Set();
let nextGrant = 0;
let fixtureServer;
let fixtureBaseURL;
let packedTarball;

const baseEnvironment = { ...process.env };
for (const variable of [
  "ARCHASTRO_API_URL",
  "ARCHASTRO_PUBLISHABLE_KEY",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "INTERN_ACCESS_TOKEN",
  "INTERN_BASE_URL",
  "INTERN_CONFIG_ROOT",
  "INTERN_MCP_PACKAGE",
  "INTERN_OAUTH_CLIENT_ID",
  "XDG_CONFIG_HOME",
]) {
  delete baseEnvironment[variable];
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd ?? packageRoot,
        env: options.env ?? baseEnvironment,
        timeout: options.timeout ?? 120_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

async function runSensitive(command, args, options = {}) {
  try {
    return await run(command, args, options);
  } catch (error) {
    const details = redact(
      `${error instanceof Error ? error.message : "command failed"}\n${error?.stdout ?? ""}\n${error?.stderr ?? ""}`,
    );
    throw new Error(`packaged command failed with redacted output:\n${details}`);
  }
}

try {
  await fs.mkdir(packDirectory);
  await exec("npm", ["run", "build"], { cwd: packageRoot });
  const { stdout } = await exec(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    { cwd: packageRoot, maxBuffer: 4 * 1024 * 1024 },
  );
  const [packed] = JSON.parse(stdout);
  if (!packed?.filename) throw new Error("npm pack did not return a tarball");
  const tarball = path.join(packDirectory, packed.filename);
  packedTarball = tarball;

  fixtureServer = http.createServer((request, response) => {
    void handleFixtureRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end('{"error":"fixture_failed"}');
    });
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const address = fixtureServer.address();
  if (!address || typeof address === "string") {
    throw new Error("OAuth fixture did not bind TCP");
  }
  fixtureBaseURL = `http://127.0.0.1:${address.port}`;

  const fakeBin = path.join(temporary, "bin");
  await fs.mkdir(fakeBin);
  for (const command of ["open", "xdg-open"]) {
    const file = path.join(fakeBin, command);
    await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  }

  // Dedicated troubleshooting-path proof: each isolated profile below maps
  // @archastro to GitHub Packages, so this harness explicitly overrides npmjs.
  // Normal setup and launcher defaults are covered separately in setup.test.ts
  // and Firstlanding's canonical packed-checkout journey.
  const setupCommand = [
    "--yes",
    `--@archastro:registry=${publicRegistry}`,
    `--package=${tarball}`,
    "intern-mcp",
  ];

  for (const host of ["codex", "claude"]) {
    await proveOAuthHost(host, setupCommand, fakeBin);
  }

  // Preserve the fast explicit-token coverage for hosts without a real CLI verifier.
  const otherHome = path.join(temporary, "other-hosts");
  await fs.mkdir(otherHome);
  await fs.writeFile(
    path.join(otherHome, ".npmrc"),
    "@archastro:registry=https://npm.pkg.github.com\n",
  );
  const otherEnvironment = fixtureEnvironment(otherHome, fakeBin);
  for (const host of ["cursor", "opencode", "rovodev", "pi"]) {
    const setup = await runSensitive(
      "npx",
      [
        ...setupCommand,
        "setup",
        "--host",
        host,
        "--token",
        "--registry",
        publicRegistry,
      ],
      { env: otherEnvironment, input: `${manualAccessToken}\n` },
    );
    assertRawOutputHasNoSecrets(`${host} manual setup`, setup);
    retainedOutput.push(setup.stdout, redact(setup.stderr));
    if (!setup.stdout.includes("Intern connected to")) {
      throw new Error(`packaged setup did not configure ${host}`);
    }
  }
  const cursor = JSON.parse(
    await fs.readFile(path.join(otherHome, ".cursor/mcp.json"), "utf8"),
  );
  assertLauncher("Cursor", JSON.stringify(cursor.mcpServers.intern));
  const pi = JSON.parse(
    await fs.readFile(path.join(otherHome, ".config/mcp/mcp.json"), "utf8"),
  );
  assertLauncher("Pi", JSON.stringify(pi.mcpServers.intern));
  const otherConfigRoot = path.join(otherHome, ".config", "intern");
  const legacyCredentialsFile = path.join(otherConfigRoot, "access-token");
  assertMode("manual config directory", await fs.stat(otherConfigRoot), 0o700);
  assertMode("manual credentials", await fs.stat(legacyCredentialsFile), 0o600);
  await assertProfileSecrets(otherHome, undefined, legacyCredentialsFile);

  assertRetainedOutputIsSafe();
  process.stdout.write(
    `Packed OAuth setup crossed real Codex and Claude profiles, rotating refresh, and retained Cursor, OpenCode, Rovo Dev, and Pi coverage for ${packed.filename}.\n`,
  );
} finally {
  if (fixtureServer) {
    await new Promise((resolve) => fixtureServer.close(() => resolve()));
  }
  await fs.rm(temporary, { recursive: true, force: true });
}

async function proveOAuthHost(host, setupCommand, fakeBin) {
  const home = path.join(temporary, `${host}-profile`);
  await fs.mkdir(home);
  await fs.writeFile(
    path.join(home, ".npmrc"),
    "@archastro:registry=https://npm.pkg.github.com\n",
  );
  const environment = fixtureEnvironment(home, fakeBin);
  const before = nextGrant;
  const setup = await runSensitive(
    "npx",
    [
      ...setupCommand,
      "setup",
      "--host",
      host,
      ...(host === "codex" ? ["--verbose"] : []),
      "--registry",
      publicRegistry,
    ],
    { env: environment },
  );
  const grant = grants.get(`device-harness-${before + 1}`);
  if (!grant || grant.polls < 2) {
    throw new Error(`${host} did not cross authorization_pending before approval`);
  }
  assertRawOAuthSetupOutput(host, setup, grant);
  retainedOutput.push(setup.stdout, redact(setup.stderr));
  if (
    !setup.stdout.includes(
      `Intern connected to ${host === "codex" ? "Codex" : "Claude Code"} as Harness · admin`,
    )
  ) {
    throw new Error(`${host} setup did not validate the OAuth credential`);
  }
  if (host === "codex" && !setup.stderr.includes("http.response")) {
    throw new Error("verbose Codex setup omitted safe HTTP diagnostics");
  }
  for (const secret of responseSecrets) {
    if (setup.stderr.includes(secret)) {
      throw new Error("verbose setup diagnostics exposed a response secret");
    }
  }

  const registration = await runSensitive(
    host,
    ["mcp", "get", "intern", ...(host === "codex" ? ["--json"] : [])],
    { env: environment },
  );
  assertRawOutputHasNoSecrets(`${host} registration diagnostics`, registration);
  retainedOutput.push(registration.stdout, redact(registration.stderr));
  assertLauncherSummary(host === "codex" ? "Codex" : "Claude", registration.stdout);
  if (host === "claude" && !registration.stdout.includes("Connected")) {
    throw new Error("Claude did not connect to the packaged Intern MCP launcher");
  }

  const savedLauncher = await readSavedLauncher(host, home);
  assertExactPackedLauncher(host, savedLauncher);
  await proveSavedLauncherStarts(host, savedLauncher, environment);

  const configRoot = path.join(home, ".config", "intern");
  const credentialsFile = path.join(configRoot, "credentials.json");
  assertMode("Intern config directory", await fs.stat(configRoot), 0o700);
  assertMode("OAuth credentials", await fs.stat(credentialsFile), 0o600);
  const credentials = JSON.parse(await fs.readFile(credentialsFile, "utf8"));
  const latest = grant.latestTokenPair;
  if (
    !latest ||
    credentials.version !== 1 ||
    credentials.platformBaseURL !== fixtureBaseURL ||
    credentials.oauthClientID !== oauthClientID ||
    credentials.tokens?.accessToken !== latest?.accessToken ||
    credentials.tokens?.refreshToken !== latest?.refreshToken ||
    credentials.tokens?.scope !== "profile" ||
    grant.refreshes !== 1 ||
    grant.generation !== 2 ||
    latest?.expiresIn !== 3600 ||
    !Number.isFinite(credentials.tokens?.expiresAtMs) ||
    credentials.tokens.expiresAtMs < latest.issuedAtMs + latest.expiresIn * 1000 ||
    credentials.tokens.expiresAtMs > Date.now() + latest.expiresIn * 1000 + 5000 ||
    credentials.tokens.expiresAtMs <= Date.now() + 60_000
  ) {
    throw new Error(
      `${host} did not persist its exact latest issuer-bound refreshed credential`,
    );
  }
  await assertProfileSecrets(home, credentialsFile);
}

function fixtureEnvironment(home, fakeBin) {
  return {
    ...baseEnvironment,
    HOME: home,
    PATH: `${fakeBin}${path.delimiter}${baseEnvironment.PATH ?? ""}`,
    ARCHASTRO_API_URL: fixtureBaseURL,
    ARCHASTRO_PUBLISHABLE_KEY: publishableKey,
    INTERN_BASE_URL: fixtureBaseURL,
    INTERN_MCP_PACKAGE: packedTarball,
    INTERN_OAUTH_CLIENT_ID: oauthClientID,
  };
}

async function handleFixtureRequest(request, response) {
  if (request.method === "POST" && request.url === "/oauth/device/authorize") {
    requirePublicClient(request, await readJSON(request), {
      client: oauthClientID,
      scope: "profile",
    });
    const ordinal = ++nextGrant;
    const deviceCode = `device-harness-${ordinal}`;
    const userCode = `TEST-${String(ordinal).padStart(4, "0")}`;
    grants.set(deviceCode, {
      ordinal,
      deviceCode,
      userCode,
      polls: 0,
      generation: 1,
      refreshes: 0,
      latestTokenPair: undefined,
    });
    sendJSON(response, 200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${fixtureBaseURL}/device`,
      verification_uri_complete: `${fixtureBaseURL}/device?code=${userCode}`,
      expires_in: 300,
      interval: 1,
    });
    return;
  }

  if (request.method === "POST" && request.url === "/oauth/token") {
    const body = await readJSON(request);
    requirePublicClient(request, body);
    if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      if (body.client !== oauthClientID || typeof body.device_code !== "string") {
        sendJSON(response, 400, { error: "invalid_request" });
        return;
      }
      const grant = grants.get(body.device_code);
      if (!grant) {
        sendJSON(response, 400, { error: "expired_token" });
        return;
      }
      grant.polls += 1;
      if (grant.polls === 1) {
        sendJSON(response, 400, { error: "authorization_pending" });
        return;
      }
      sendTokenPair(response, grant);
      return;
    }
    if (body.grant_type === "refresh_token" && typeof body.refresh_token === "string") {
      const grant = validRefreshTokens.get(body.refresh_token);
      if (!grant) {
        sendJSON(response, 400, { error: "invalid_grant" });
        return;
      }
      validRefreshTokens.delete(body.refresh_token);
      grant.generation += 1;
      grant.refreshes += 1;
      sendTokenPair(response, grant, 3600);
      return;
    }
    sendJSON(response, 400, { error: "unsupported_grant_type" });
    return;
  }

  if (request.method === "GET" && request.url === "/api/v1/mcp/session") {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    if (!token || (token !== manualAccessToken && !activeAccessTokens.has(token))) {
      sendJSON(response, 401, { error: "unauthorized" });
      return;
    }
    response.setHeader("set-cookie", `session=${responseSecrets[0]}`);
    response.setHeader("x-private-header", responseSecrets[1]);
    response.setHeader("x-request-id", "harness-request-id");
    sendJSON(response, 200, {
      user: {
        id: "usr_harness",
        org: "org_harness",
        org_name: "Harness",
        org_role: "admin",
      },
      org: { id: "intorg_harness", slug: "harness", state: "active" },
    });
    return;
  }

  sendJSON(response, 404, { error: "not_found" });
}

function sendTokenPair(response, grant, expiresIn = 1) {
  const accessToken = `harness-access-token-${grant.ordinal}-${grant.generation}`;
  const refreshToken = `harness-refresh-token-${grant.ordinal}-${grant.generation}`;
  if (grant.latestTokenPair) {
    activeAccessTokens.delete(grant.latestTokenPair.accessToken);
    validRefreshTokens.delete(grant.latestTokenPair.refreshToken);
  }
  const issuedAtMs = Date.now();
  grant.latestTokenPair = {
    accessToken,
    refreshToken,
    expiresIn,
    issuedAtMs,
  };
  activeAccessTokens.set(accessToken, grant);
  validRefreshTokens.set(refreshToken, grant);
  issuedOAuthTokens.add(accessToken);
  issuedOAuthTokens.add(refreshToken);
  sendJSON(response, 200, {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    scope: "profile",
    token_type: "Bearer",
  });
}

function requirePublicClient(request, body, expectedBody) {
  if (request.headers["x-archastro-api-key"] !== publishableKey) {
    throw new Error("fixture received the wrong publishable key");
  }
  if (expectedBody && !sameFlatObject(body, expectedBody)) {
    throw new Error("fixture received the wrong device authorization body");
  }
}

function sameFlatObject(actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

async function readJSON(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJSON(response, status, body) {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}

function assertLauncher(label, output) {
  const registryOverrides = [
    ...output.matchAll(/--@archastro:registry=([^\s",]+)/g),
  ].map((match) => match[1]);
  if (
    !output.includes("intern-mcp") ||
    !output.includes("launch") ||
    !output.includes("--prefer-online") ||
    registryOverrides.length !== 1 ||
    registryOverrides[0] !== publicRegistry
  ) {
    throw new Error(`${label} did not persist the complete public Intern launcher`);
  }
  if (containsFixtureSecret(output)) {
    throw new Error(`${label} persisted an OAuth or device secret`);
  }
}

function assertLauncherSummary(label, output) {
  assertLauncher(label, output);
  const packageArguments = [...output.matchAll(/--package=([^\s",]+)/g)].map(
    (match) => match[1],
  );
  if (packageArguments.length !== 1 || packageArguments[0] !== packedTarball) {
    throw new Error(`${label} summary did not select the packed tarball exactly once`);
  }
}

async function readSavedLauncher(host, home) {
  if (host === "claude") {
    const document = JSON.parse(
      await fs.readFile(path.join(home, ".claude.json"), "utf8"),
    );
    const intern = document.mcpServers?.intern;
    if (!intern || typeof intern !== "object") {
      throw new Error("Claude host config does not contain Intern");
    }
    return {
      command: intern.command,
      args: intern.args,
      env: intern.env ?? {},
    };
  }

  const config = await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8");
  const sections = [...config.matchAll(/^\[mcp_servers\.intern\]\s*$/gm)];
  if (sections.length !== 1) {
    throw new Error("Codex host config does not contain exactly one Intern section");
  }
  const start = sections[0].index + sections[0][0].length;
  const rest = config.slice(start);
  const end = rest.search(/^\[/m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const command = section.match(/^command\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const argsValue = section.match(/^args\s*=\s*(\[[^\n]*\])\s*$/m)?.[1];
  if (!command || !argsValue) {
    throw new Error(
      "Codex Intern section does not contain a readable command and args",
    );
  }
  let args;
  try {
    args = JSON.parse(argsValue);
  } catch {
    throw new Error("Codex Intern args are not a simple string array");
  }
  const env = {};
  const envHeader = config.match(/^\[mcp_servers\.intern\.env\]\s*$/m);
  if (envHeader) {
    const envRest = config.slice(envHeader.index + envHeader[0].length);
    const envEnd = envRest.search(/^\[/m);
    const envSection = envEnd === -1 ? envRest : envRest.slice(0, envEnd);
    for (const match of envSection.matchAll(
      /^"?([A-Z][A-Z0-9_]*)"?\s*=\s*"([^"\n]*)"\s*$/gm,
    )) {
      env[match[1]] = match[2];
    }
  }
  return { command, args, env };
}

function assertExactPackedLauncher(label, launcher) {
  const expectedArgs = [
    "--yes",
    "--prefer-online",
    `--@archastro:registry=${publicRegistry}`,
    `--package=${packedTarball}`,
    "intern-mcp",
    "launch",
  ];
  if (
    launcher.command !== "npx" ||
    !Array.isArray(launcher.args) ||
    JSON.stringify(launcher.args) !== JSON.stringify(expectedArgs) ||
    launcher.env?.ARCHASTRO_API_URL !== fixtureBaseURL ||
    launcher.env?.ARCHASTRO_PUBLISHABLE_KEY !== publishableKey ||
    launcher.env?.INTERN_OAUTH_CLIENT_ID !== oauthClientID
  ) {
    throw new Error(
      `${label} host config does not point exclusively at the current packed tarball`,
    );
  }
  const serialized = JSON.stringify(launcher);
  if (
    serialized.includes("@archastro/intern-mcp@latest") ||
    containsFixtureSecret(serialized)
  ) {
    throw new Error(`${label} host config contains a floating package or secret`);
  }
}

async function proveSavedLauncherStarts(label, launcher, environment) {
  const ambient = { ...environment };
  delete ambient.ARCHASTRO_API_URL;
  delete ambient.ARCHASTRO_PUBLISHABLE_KEY;
  delete ambient.INTERN_OAUTH_CLIENT_ID;
  const transport = new StdioClientTransport({
    command: launcher.command,
    args: launcher.args,
    env: { ...ambient, ...launcher.env },
    stderr: "pipe",
  });
  let rawStderr = "";
  transport.stderr?.on("data", (chunk) => {
    rawStderr += chunk.toString();
  });
  const client = new Client({
    name: `intern-${label}-packed-launcher-proof`,
    version: "1.0.0",
  });
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new Error("packed launcher proof timed out")),
    15_000,
  );
  deadlineTimer.unref();
  let proofFailure;
  try {
    await client.connect(transport, {
      signal: deadline.signal,
      timeout: 10_000,
      maxTotalTimeout: 10_000,
    });
    const tools = await client.listTools(undefined, {
      signal: deadline.signal,
      timeout: 5_000,
      maxTotalTimeout: 5_000,
    });
    if (!tools.tools.some((tool) => tool.name === "intern_auth_status")) {
      throw new Error(`${label} packed launcher did not expose Intern tools`);
    }
  } catch (error) {
    proofFailure = new Error(
      `${label} packed launcher proof failed (${safeErrorName(error)})`,
    );
  } finally {
    clearTimeout(deadlineTimer);
    deadline.abort(new Error("packed launcher proof finished"));
    try {
      await closeAndReapPackedLauncher(client, transport);
    } catch (error) {
      proofFailure ??= new Error(
        `${label} packed launcher cleanup failed (${safeErrorName(error)})`,
      );
    }
    assertRawOutputHasNoSecrets(`${label} packed launcher diagnostics`, {
      stdout: "",
      stderr: rawStderr,
    });
    retainedOutput.push(redact(rawStderr));
  }
  if (proofFailure) throw proofFailure;
}

async function closeAndReapPackedLauncher(client, transport) {
  const pid = transport.pid;
  const clientClose = Promise.resolve()
    .then(() => client.close())
    .catch(() => {});
  const transportClose = Promise.resolve()
    .then(() => transport.close())
    .catch(() => {});
  await settlesWithin(Promise.all([clientClose, transportClose]), 5000);
  if (pid && processIsAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The launcher exited between the liveness check and the signal.
    }
    await waitForProcessExit(pid, 1000);
  }
  if (pid && processIsAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The launcher exited between the liveness check and the signal.
    }
    await waitForProcessExit(pid, 2000);
  }
  const closed = await settlesWithin(Promise.all([clientClose, transportClose]), 2000);
  if (!closed || (pid && processIsAlive(pid))) {
    throw new Error(
      "packed launcher child did not exit and reap before cleanup deadline",
    );
  }
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  const settled = await Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  return settled;
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function safeErrorName(error) {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
    ? error.name
    : "Error";
}

function assertRawOAuthSetupOutput(label, output, grant) {
  const combined = `${output.stdout}\n${output.stderr}`;
  for (const secret of fixtureSecrets()) {
    if (secret !== grant.userCode && combined.includes(secret)) {
      throw new Error(`${label} raw setup output exposed an OAuth secret`);
    }
  }
  if (output.stdout.includes(grant.userCode)) {
    throw new Error(`${label} stdout unexpectedly exposed the approval code`);
  }
  const expectedLines = new Map([
    [`Open ${fixtureBaseURL}/device?code=${grant.userCode}`, 0],
    [`Code: ${grant.userCode}`, 0],
  ]);
  let unexpectedOccurrences = 0;
  for (const line of output.stderr.split(/\r?\n/)) {
    if (!line.includes(grant.userCode)) continue;
    if (expectedLines.has(line)) expectedLines.set(line, expectedLines.get(line) + 1);
    else unexpectedOccurrences += countOccurrences(line, grant.userCode);
  }
  if (
    unexpectedOccurrences !== 0 ||
    [...expectedLines.values()].some((count) => count !== 1) ||
    countOccurrences(output.stderr, grant.userCode) !== 2
  ) {
    throw new Error(
      `${label} did not confine its approval code to the two intended display lines`,
    );
  }
}

function assertRawOutputHasNoSecrets(label, output) {
  if (containsFixtureSecret(`${output.stdout}\n${output.stderr}`)) {
    throw new Error(`${label} exposed a fixture secret`);
  }
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

async function assertProfileSecrets(root, credentialsFile, legacyCredentialsFile) {
  for (const file of await filesBelow(root)) {
    const contents = await fs.readFile(file, "utf8").catch(() => "");
    const isCredentials =
      credentialsFile && path.resolve(file) === path.resolve(credentialsFile);
    const isLegacyCredentials =
      legacyCredentialsFile &&
      path.resolve(file) === path.resolve(legacyCredentialsFile);
    for (const secret of fixtureSecrets()) {
      if (!contents.includes(secret)) continue;
      const isOAuthToken =
        secret.startsWith("harness-access-") || secret.startsWith("harness-refresh-");
      if (isCredentials && isOAuthToken) continue;
      if (isLegacyCredentials && secret === manualAccessToken) continue;
      const category = isOAuthToken
        ? "OAuth token"
        : secret === manualAccessToken
          ? "manual token"
          : "device or response secret";
      throw new Error(
        `an isolated host profile persisted a ${category} in ${path.relative(root, file)}`,
      );
    }
  }
}

async function filesBelow(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(file)));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

function assertRetainedOutputIsSafe() {
  if (containsFixtureSecret(retainedOutput.join("\n"))) {
    throw new Error("retained harness output contains an OAuth or device secret");
  }
}

function containsFixtureSecret(value) {
  return fixtureSecrets().some((secret) => value.includes(secret));
}

function fixtureSecrets() {
  return [
    manualAccessToken,
    ...responseSecrets,
    ...[...grants.values()].flatMap((grant) => [grant.deviceCode, grant.userCode]),
    ...issuedOAuthTokens,
  ];
}

function redact(value) {
  let redacted = String(value).replace(/\b[A-Z]{4}-\d{4}\b/g, "[device-code]");
  for (const secret of fixtureSecrets()) {
    redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

function assertMode(label, stat, expected) {
  const actual = stat.mode & 0o777;
  if (actual !== expected) {
    throw new Error(
      `${label} permissions were ${actual.toString(8)}, expected ${expected.toString(8)}`,
    );
  }
}
