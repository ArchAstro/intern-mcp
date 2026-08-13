import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-package-"));

try {
  await exec("npm", ["run", "build"], { cwd: packageRoot });
  const { stdout } = await exec(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: packageRoot, maxBuffer: 4 * 1024 * 1024 },
  );
  const [packed] = JSON.parse(stdout);
  if (!packed?.filename) throw new Error("npm pack did not return a tarball");
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of ["package.json", "README.md", "dist/index.js"]) {
    if (!files.has(required)) throw new Error(`packed MCP is missing ${required}`);
  }
  if ([...files].some((file) => file.startsWith("src/") || file.endsWith(".test.js"))) {
    throw new Error("packed MCP contains source or test files");
  }

  const consumer = path.join(temporary, "consumer");
  await fs.mkdir(consumer);
  await fs.writeFile(
    path.join(consumer, "package.json"),
    '{"name":"intern-mcp-package-smoke","private":true}\n',
  );
  const tarball = path.join(temporary, packed.filename);
  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      tarball,
    ],
    { cwd: consumer, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );

  // Cross the clean consumer's installed bin and real MCP stdio boundary.
  const executable = path.join(consumer, "node_modules/.bin/intern-mcp");
  const transport = new StdioClientTransport({
    command: executable,
    args: ["serve"],
    env: {
      ...process.env,
      INTERN_CONFIG_ROOT: path.join(temporary, "config"),
      INTERN_WORKSPACE_ROOT: path.join(temporary, "sites"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "intern-package-proof", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === "intern_prepare_site")) {
      throw new Error("packed MCP did not expose intern_prepare_site");
    }
    process.stdout.write(
      `Packed ${packed.filename}; clean install exposed ${tools.tools.length} MCP tools.\n`,
    );
  } finally {
    await client.close();
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
