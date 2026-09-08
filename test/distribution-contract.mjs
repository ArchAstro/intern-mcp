import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const json = async (file) => JSON.parse(await readFile(new URL(file, root), "utf8"));

test("hosted listing artifacts use one remote endpoint without local launchers or credentials", async () => {
  const endpoint = "https://tryintern.dev/mcp";
  const registry = await json("server.json");
  const mcp = await json("mcp.json");
  const plugin = await json("plugin.json");
  const gemini = await json("gemini-extension.json");

  assert.equal(registry.name, "dev.tryintern/intern");
  assert.deepEqual(registry.remotes, [{ type: "streamable-http", url: endpoint }]);
  assert.equal(registry.packages, undefined);
  assert.deepEqual(mcp.mcpServers, {
    intern: { type: "streamable-http", url: endpoint },
  });
  assert.deepEqual(gemini.mcpServers, { intern: { httpUrl: endpoint } });
  assert.equal(plugin.name, gemini.name);
  assert.equal(plugin.version, gemini.version);
  assert.equal(plugin.version, registry.version);
  assert.equal(plugin.repository, registry.repository.url);
  assert.equal(plugin.homepage, "https://tryintern.dev");
  assert.equal(plugin.license, "MIT");
  assert.deepEqual(registry.icons, [
    {
      src: "https://tryintern.dev/brand-mark.svg",
      mimeType: "image/svg+xml",
      sizes: ["any"],
    },
  ]);
  assert.equal(
    plugin.$schema,
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  );
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");

  // Hosted distribution must not silently replace the existing local package.
  const local = await json("package.json");
  assert.equal(local.name, "@archastro/intern-mcp");
  assert.equal(local.bin["intern-mcp"], "dist/index.js");
  assert.equal(local.license, "MIT");
  assert.match(
    await readFile(new URL("LICENSE", root), "utf8"),
    /^MIT License\n\nCopyright \(c\) 2026 ArchAstro Inc\./,
  );
});
