import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import type { InternSite, SiteRuntimeContract } from "./api.js";
import { WorkspaceManager } from "./workspace.js";
import type { SSHCredentialManager } from "./ssh.js";

const exec = promisify(execFile);
const roots: string[] = [];
const contract = JSON.parse(
  await fs.readFile(
    fileURLToPath(new URL("../test/fixtures/runtime-contract.json", import.meta.url)),
    "utf8",
  ),
) as SiteRuntimeContract;
const launcher = contract.protectedFiles["run-site.sh"];
const serverRuntime = contract.protectedFiles["server.mjs"];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  ),
);

describe("WorkspaceManager", () => {
  test("clones the expected repository and refuses dirty publication", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-workspace-"));
    roots.push(root);
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["clone", remote, seed]);
    await exec("git", ["config", "user.email", "proof@localhost"], { cwd: seed });
    await exec("git", ["config", "user.name", "Proof"], { cwd: seed });
    await fs.writeFile(path.join(seed, "index.html"), "first\n");
    await fs.writeFile(
      path.join(seed, "package.json"),
      '{"private":true,"type":"module"}\n',
    );
    await fs.writeFile(
      path.join(seed, "server.mjs"),
      serverRuntime.replaceAll("{{PORT}}", "4100"),
    );
    await fs.writeFile(path.join(seed, "run-site.sh"), launcher, { mode: 0o750 });
    await fs.mkdir(path.join(seed, "assets"));
    await fs.writeFile(path.join(seed, "assets/page.html"), "tracked asset\n");
    await exec("git", ["add", "."], { cwd: seed });
    await exec("git", ["commit", "-m", "seed"], { cwd: seed });
    await exec("git", ["push", "origin", "HEAD:main"], { cwd: seed });
    await exec("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });

    const workspaceRoot = path.join(root, "workspaces");
    const credentialRequests: string[] = [];
    const ssh = {
      async command(gitURL: string) {
        credentialRequests.push(gitURL);
        return undefined;
      },
      async clearCertificate() {},
    } as SSHCredentialManager;
    const manager = new WorkspaceManager(
      {
        internBaseURL: "",
        archAstroBaseURL: "",
        workspaceRoot,
        configRoot: path.join(root, "config"),
      },
      ssh,
    );
    const site = {
      slug: "docs",
      orgSlug: "acme",
      siteType: "vite",
      port: 4100,
      gitUrl: remote,
    } as InternSite;
    const prepared = await manager.prepare("acme", site);
    expect(prepared.path).toBe(path.join(workspaceRoot, "acme", "docs"));
    expect(prepared.dirty).toBe(false);
    expect(credentialRequests).toEqual([remote]);

    await fs.writeFile(path.join(prepared.path, "index.html"), "uncommitted\n");
    await expect(manager.publish("acme", site, contract)).rejects.toThrow(
      "dirty worktree",
    );
    expect(await fs.readFile(path.join(prepared.path, "index.html"), "utf8")).toBe(
      "uncommitted\n",
    );

    await exec("git", ["restore", "index.html"], { cwd: prepared.path });
    await manager.publish("acme", site, contract);
    expect(credentialRequests).toEqual([remote, remote]);
    const outsideAssets = path.join(root, "outside-assets");
    await fs.mkdir(outsideAssets);
    await fs.writeFile(path.join(outsideAssets, "page.html"), "outside secret\n");
    await fs.rm(path.join(prepared.path, "assets"), { recursive: true });
    await fs.symlink(outsideAssets, path.join(prepared.path, "assets"));
    await expect(manager.testWorkingTree("acme", site, contract)).rejects.toThrow(
      "symlinked parent",
    );
    await fs.rm(path.join(prepared.path, "assets"));
    await exec("git", ["restore", "assets"], { cwd: prepared.path });

    await exec(
      "git",
      ["remote", "set-url", "--push", "origin", path.join(root, "attacker.git")],
      { cwd: prepared.path },
    );
    await expect(manager.publish("acme", site, contract)).rejects.toThrow(
      "unexpected Git push URL",
    );
  });

  test("rejects a committed site that the Intern runtime cannot install or start", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-validation-"));
    roots.push(root);
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    await exec("git", ["init", "--bare", remote]);
    await exec("git", ["clone", remote, seed]);
    await exec("git", ["config", "user.email", "proof@localhost"], { cwd: seed });
    await exec("git", ["config", "user.name", "Proof"], { cwd: seed });
    await fs.writeFile(path.join(seed, "index.html"), "first\n");
    await fs.writeFile(
      path.join(seed, "package.json"),
      '{"private":true,"type":"module","dependencies":{"express":"latest"}}\n',
    );
    await fs.writeFile(
      path.join(seed, "server.mjs"),
      serverRuntime.replaceAll("{{PORT}}", "4100"),
    );
    await fs.writeFile(path.join(seed, "run-site.sh"), launcher, { mode: 0o750 });
    await exec("git", ["add", "."], { cwd: seed });
    await exec("git", ["commit", "-m", "unsupported dependency"], { cwd: seed });
    await exec("git", ["push", "origin", "HEAD:main"], { cwd: seed });
    await exec("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });

    const manager = new WorkspaceManager({
      internBaseURL: "",
      archAstroBaseURL: "",
      workspaceRoot: path.join(root, "workspaces"),
      configRoot: path.join(root, "config"),
    });
    const site = {
      slug: "docs",
      orgSlug: "acme",
      siteType: "vite",
      port: 4100,
      gitUrl: remote,
    } as InternSite;
    await manager.prepare("acme", site);
    const validation = await manager.validate("acme", site, contract);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        code: "package_install_unsupported",
        path: "package.json",
      }),
    );

    await fs.writeFile(
      path.join(seed, "package.json"),
      '{"private":true,"type":"module"}\n',
    );
    await fs.chmod(path.join(seed, "run-site.sh"), 0o640);
    await exec("git", ["add", "package.json", "run-site.sh"], { cwd: seed });
    await exec("git", ["commit", "-m", "break launcher mode"], { cwd: seed });
    await exec("git", ["push", "origin", "HEAD:main"], { cwd: seed });
    await exec("git", ["fetch", "origin"], {
      cwd: preparedPath(manager, "acme", "docs"),
    });
    await exec("git", ["reset", "--hard", "FETCH_HEAD"], {
      cwd: preparedPath(manager, "acme", "docs"),
    });
    const invalidMode = await manager.validate("acme", site, contract);
    expect(invalidMode.issues).toContainEqual(
      expect.objectContaining({ code: "launcher_not_executable", path: "run-site.sh" }),
    );
    await expect(manager.publish("acme", site, contract)).rejects.toThrow(
      "VALIDATION_FAILED",
    );
  });

  test("rejects invalid slugs before resolving a path", async () => {
    const manager = new WorkspaceManager({
      internBaseURL: "",
      archAstroBaseURL: "",
      workspaceRoot: "/tmp/intern-safe",
      configRoot: "/tmp/intern-config",
    });
    expect(() => manager.checkoutPath("acme", "../escape")).toThrow(
      "invalid Intern org or site slug",
    );
  });

  test("refuses to clone through a symlinked organization directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-symlink-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workspaceRoot, "acme"));
    const manager = new WorkspaceManager({
      internBaseURL: "",
      archAstroBaseURL: "",
      workspaceRoot,
      configRoot: path.join(root, "config"),
    });
    const site = {
      slug: "docs",
      orgSlug: "acme",
      gitUrl: path.join(root, "missing.git"),
    } as InternSite;

    await expect(manager.prepare("acme", site)).rejects.toThrow(
      "symlink escapes configured root",
    );
    await expect(fs.stat(path.join(outside, "docs"))).rejects.toThrow();
  });
});

function preparedPath(manager: WorkspaceManager, org: string, site: string): string {
  return manager.checkoutPath(org, site);
}
