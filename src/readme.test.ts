import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

let readme = "";
let readmeFlat = "";

beforeAll(async () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  readme = await fs.readFile(path.join(repository, "README.md"), "utf8");
  readmeFlat = readme.replace(/\s+/g, " ");
});

describe("published installation guide", () => {
  test("leads with the plain public npm command and browser approval", () => {
    expect(readme).toContain(
      "npx --yes @archastro/intern-mcp@latest setup --host codex",
    );
    expect(readme.slice(0, readme.indexOf("## Troubleshooting"))).not.toContain(
      "--@archastro:registry=",
    );
    expect(readme).toMatch(/opens your browser/i);
    expect(readme).toMatch(/prints the approval URL and one-time code/i);
  });

  test("keeps the scoped registry override under troubleshooting", () => {
    const troubleshooting = readme.slice(readme.indexOf("## Troubleshooting"));
    expect(troubleshooting).toContain(
      "npx --yes --@archastro:registry=https://registry.npmjs.org \\",
    );
    expect(troubleshooting).toContain(
      "@archastro/intern-mcp@latest setup --host codex \\",
    );
    expect(troubleshooting).toContain("--registry https://registry.npmjs.org");
  });

  test("documents issuer-bound private credentials and automatic refresh", () => {
    expect(readme).toContain("~/.config/intern/credentials.json");
    expect(readme).toMatch(/mode `0600`/);
    expect(readmeFlat).toMatch(/bound to the Platform issuer and OAuth client/i);
    expect(readmeFlat).toMatch(/refreshes .* automatically/i);
  });

  test.each([
    ["codex", "Start a new Codex task"],
    ["claude", "Start a new Claude Code session"],
    ["grok", "Start a new Grok session"],
    ["cursor", "Start a new Cursor session"],
    ["opencode", "Start a new OpenCode session"],
    ["rovodev", "Start a new Rovo Dev session"],
    ["pi", "Start a new Pi session"],
  ])("documents setup and the next action for %s", (host, nextAction) => {
    expect(readme).toContain(`setup --host ${host}`);
    expect(readmeFlat).toContain(nextAction);
  });

  test("keeps profile tokens as an explicit manual and CI alternative", () => {
    expect(readme).toMatch(/## Manual and CI authentication/);
    expect(readme).toContain("INTERN_ACCESS_TOKEN");
    expect(readme).toContain("setup --host codex --token");
  });

  test("does not claim the TryIntern frontend already uses the new installer", () => {
    expect(readmeFlat).toMatch(/TryIntern Connect.*remains on the manual-token flow/i);
    expect(readme).toMatch(/public-package release gate/i);
  });
});
