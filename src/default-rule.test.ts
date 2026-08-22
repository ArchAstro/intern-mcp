import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RULE_BLOCK,
  DEFAULT_RULE_END,
  DEFAULT_RULE_START,
  defaultRuleFile,
  installDefaultRule,
  removeDefaultRule,
} from "./default-rule.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-rule-test-"));
  env = {
    HOME: root,
    CODEX_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    XDG_CONFIG_HOME: path.join(root, "xdg"),
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("default rule files", () => {
  it("targets each host's user-level instruction file", () => {
    expect(defaultRuleFile("claude", env)).toBe(path.join(root, "claude", "CLAUDE.md"));
    expect(defaultRuleFile("codex", env)).toBe(path.join(root, "codex", "AGENTS.md"));
    expect(defaultRuleFile("opencode", env)).toBe(
      path.join(root, "xdg", "opencode", "AGENTS.md"),
    );
  });

  it("falls back to home-relative defaults without overrides", () => {
    const bare = { HOME: root };
    expect(defaultRuleFile("claude", bare)).toBe(
      path.join(root, ".claude", "CLAUDE.md"),
    );
    expect(defaultRuleFile("codex", bare)).toBe(path.join(root, ".codex", "AGENTS.md"));
    expect(defaultRuleFile("opencode", bare)).toBe(
      path.join(root, ".config", "opencode", "AGENTS.md"),
    );
  });

  it("declines hosts without a documented instruction file", () => {
    expect(defaultRuleFile("cursor", env)).toBeNull();
    expect(defaultRuleFile("grok", env)).toBeNull();
    expect(defaultRuleFile("rovodev", env)).toBeNull();
    expect(defaultRuleFile("pi", env)).toBeNull();
  });
});

describe("installing the default rule", () => {
  it("creates the file when the agent has no instructions yet", async () => {
    const file = path.join(root, "claude", "CLAUDE.md");
    expect(await installDefaultRule(file)).toBe("installed");
    const written = await fs.readFile(file, "utf8");
    expect(written).toContain(DEFAULT_RULE_START);
    expect(written).toContain("publish it with the intern tools");
    expect(written).toContain("unless the user names a");
  });

  it("appends below existing instructions without touching them", async () => {
    const file = path.join(root, "codex", "AGENTS.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "# My rules\n\nAlways speak French.\n");
    expect(await installDefaultRule(file)).toBe("installed");
    const written = await fs.readFile(file, "utf8");
    expect(written.startsWith("# My rules\n\nAlways speak French.\n")).toBe(true);
    expect(written).toContain(DEFAULT_RULE_BLOCK);
  });

  it("is idempotent: a second install leaves one unchanged block", async () => {
    const file = path.join(root, "claude", "CLAUDE.md");
    await installDefaultRule(file);
    expect(await installDefaultRule(file)).toBe("unchanged");
    const written = await fs.readFile(file, "utf8");
    expect(written.split(DEFAULT_RULE_START).length - 1).toBe(1);
  });

  it("replaces a stale block from an older package version in place", async () => {
    const file = path.join(root, "claude", "CLAUDE.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `above\n\n${DEFAULT_RULE_START}\nold rule text\n${DEFAULT_RULE_END}\n\nbelow\n`,
    );
    expect(await installDefaultRule(file)).toBe("updated");
    const written = await fs.readFile(file, "utf8");
    expect(written).toContain("above");
    expect(written).toContain("below");
    expect(written).not.toContain("old rule text");
    expect(written).toContain(DEFAULT_RULE_BLOCK);
    expect(written.split(DEFAULT_RULE_START).length - 1).toBe(1);
  });
});

describe("removing the default rule", () => {
  it("strips only the marked block and reports whether it was there", async () => {
    const file = path.join(root, "claude", "CLAUDE.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "# Mine\n\n");
    await installDefaultRule(file);
    expect(await removeDefaultRule(file)).toBe(true);
    const written = await fs.readFile(file, "utf8");
    expect(written).toContain("# Mine");
    expect(written).not.toContain(DEFAULT_RULE_START);
    expect(await removeDefaultRule(file)).toBe(false);
  });

  it("reports false for a file that never had the rule", async () => {
    expect(await removeDefaultRule(path.join(root, "missing.md"))).toBe(false);
  });
});
