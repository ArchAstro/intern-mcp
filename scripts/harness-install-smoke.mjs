import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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
  const packagedCommand = [
    "npx",
    "--yes",
    `--@archastro:registry=${publicRegistry}`,
    `--package=${tarball}`,
    "intern-mcp",
    "serve",
  ];

  // Cross each harness's real configuration writer in an isolated home.
  await run("codex", ["mcp", "add", "intern", "--", ...packagedCommand]);
  const codex = await run("codex", ["mcp", "get", "intern"]);
  if (!codex.stdout.includes("intern-mcp") || !codex.stdout.includes("serve")) {
    throw new Error("Codex did not persist the packaged Intern MCP command");
  }

  await run("claude", [
    "mcp",
    "add",
    "--transport",
    "stdio",
    "--scope",
    "user",
    "intern",
    "--",
    ...packagedCommand,
  ]);
  const claude = await run("claude", ["mcp", "get", "intern"]);
  if (
    !claude.stdout.includes("intern-mcp") ||
    !claude.stdout.includes("serve") ||
    !claude.stdout.includes("Connected")
  ) {
    throw new Error("Claude did not connect to the packaged Intern MCP command");
  }

  process.stdout.write(
    `Codex registered and Claude connected to ${packed.filename} from isolated homes.\n`,
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
