import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-harnesses-"));
const isolatedHome = path.join(temporary, "home");
const packDirectory = path.join(temporary, "package");
const environment = { ...process.env, HOME: isolatedHome };
for (const variable of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
  delete environment[variable];
}
const publicRegistry = "https://registry.npmjs.org";
let sessionServer;

async function run(command, args) {
  return exec(command, args, {
    cwd: packageRoot,
    env: environment,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

try {
  await fs.mkdir(isolatedHome);
  await fs.mkdir(packDirectory);
  // Model a developer machine that normally routes @archastro elsewhere.
  await fs.writeFile(
    path.join(isolatedHome, ".npmrc"),
    "@archastro:registry=https://npm.pkg.github.com\n",
  );
  const registry = await run("npm", [
    "config",
    "get",
    "@archastro:registry",
    `--@archastro:registry=${publicRegistry}`,
  ]);
  if (registry.stdout.trim() !== publicRegistry) {
    throw new Error("scoped npm override did not select the public registry");
  }
  await exec("npm", ["run", "build"], { cwd: packageRoot });
  const { stdout } = await exec(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    { cwd: packageRoot, maxBuffer: 4 * 1024 * 1024 },
  );
  const [packed] = JSON.parse(stdout);
  if (!packed?.filename) throw new Error("npm pack did not return a tarball");
  const tarball = path.join(packDirectory, packed.filename);
  sessionServer = http.createServer((request, response) => {
    if (
      request.url !== "/api/v1/mcp/session" ||
      request.headers.authorization !== "Bearer harness-proof-token"
    ) {
      response
        .writeHead(401, { "content-type": "application/json" })
        .end('{"error":"unauthorized"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        user: {
          id: "usr_harness",
          org: "org_harness",
          org_name: "Harness",
          org_role: "admin",
        },
        org: { id: "intorg_harness", slug: "harness", state: "active" },
      }),
    );
  });
  await new Promise((resolve) => sessionServer.listen(0, "127.0.0.1", resolve));
  const address = sessionServer.address();
  if (!address || typeof address === "string") {
    throw new Error("setup proof API did not bind TCP");
  }
  environment.INTERN_ACCESS_TOKEN = "harness-proof-token";
  environment.INTERN_BASE_URL = `http://127.0.0.1:${address.port}`;
  environment.INTERN_MCP_PACKAGE = tarball;
  const setupCommand = [
    "--yes",
    `--@archastro:registry=${publicRegistry}`,
    `--package=${tarball}`,
    "intern-mcp",
  ];

  // Cross the packaged setup command and each real host configuration writer.
  const codexSetup = await run("npx", [...setupCommand, "setup", "--host", "codex"]);
  if (!codexSetup.stdout.includes("Intern connected to Codex as Harness · admin")) {
    throw new Error("packaged setup did not validate and configure Codex");
  }
  const codex = await run("codex", ["mcp", "get", "intern"]);
  if (
    !codex.stdout.includes("intern-mcp") ||
    !codex.stdout.includes("launch") ||
    codex.stdout.includes("harness-proof-token")
  ) {
    throw new Error("Codex did not persist the packaged Intern MCP profile launcher");
  }

  const claudeSetup = await run("npx", [...setupCommand, "setup", "--host", "claude"]);
  if (
    !claudeSetup.stdout.includes("Intern connected to Claude Code as Harness · admin")
  ) {
    throw new Error("packaged setup did not validate and configure Claude Code");
  }
  const claude = await run("claude", ["mcp", "get", "intern"]);
  if (
    !claude.stdout.includes("intern-mcp") ||
    !claude.stdout.includes("launch") ||
    claude.stdout.includes("harness-proof-token") ||
    !claude.stdout.includes("Connected")
  ) {
    throw new Error("Claude did not connect to the packaged Intern MCP command");
  }

  process.stdout.write(
    `Packaged setup validated Intern and configured Codex and Claude for ${packed.filename} in isolated homes.\n`,
  );
} finally {
  if (sessionServer) {
    await new Promise((resolve) => sessionServer.close(() => resolve()));
  }
  await fs.rm(temporary, { recursive: true, force: true });
}
