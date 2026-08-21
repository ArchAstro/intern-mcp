import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { InternConfig } from "./config.js";
import {
  isAcceptedProtectedFile,
  renderProtectedFile,
  type InternSession,
  type InternSite,
  type SiteRuntimeContract,
} from "./api.js";
import {
  missingCommittedBuildOutput,
  runLocalSiteBuild,
  validateSite,
  type RunningSiteRuntime,
  type SiteValidation,
  type ValidationIssue,
} from "./validation.js";
import type { SSHCredentialManager } from "./ssh.js";
import {
  defaultLocalUser,
  localUserFromSession,
  startLocalPreviewRuntime,
} from "./preview.js";

const exec = promisify(execFile);
const slugPattern = /^[a-z][a-z0-9-]{0,62}$/;
const maxCommitFiles = 10_000;
const maxCommitBytes = 100 * 1024 * 1024;
const maxFileBytes = 25 * 1024 * 1024;

export interface WorkspaceStatus {
  path: string;
  branch: string;
  head: string;
  dirty: boolean;
  changes: string[];
  remote: string;
  pushRemote: string;
}

export interface PublishedWorkspace {
  workspace: WorkspaceStatus;
  validation: SiteValidation;
}

interface LocalSiteTestBase {
  testedHead: string;
  source: "working-tree";
  validation: SiteValidation;
}

export type LocalSiteTest =
  | (LocalSiteTestBase & { running: true; url: string })
  | (LocalSiteTestBase & { running: false });

interface LocalSiteTestSession {
  runtime: RunningSiteRuntime;
  temporary: string;
}

interface CheckoutAnchor {
  handle: FileHandle;
  realPath: string;
  dev: number;
  ino: number;
}

export class WorkspaceManager {
  private readonly localTests = new Map<string, LocalSiteTestSession>();
  private readonly testLocks = new Map<string, Promise<void>>();
  private readonly lifecycleLocks = new Map<string, Promise<void>>();
  private readonly globalTestLocks = new Map<string, Promise<void>>();
  private closing = false;

  constructor(
    private readonly config: InternConfig,
    private readonly ssh?: SSHCredentialManager,
  ) {}

  async prepare(
    orgSlug: string,
    site: InternSite,
    contract?: SiteRuntimeContract,
  ): Promise<WorkspaceStatus> {
    const checkout = this.checkoutPath(orgSlug, site.slug);
    await fs.mkdir(path.dirname(checkout), { recursive: true });
    await this.assertContained(path.dirname(checkout));
    const stat = await fs.stat(checkout).catch(() => null);
    if (!stat) {
      await this.git(
        path.dirname(checkout),
        ["clone", "--", site.gitUrl, checkout],
        await this.ssh?.command(site.gitUrl),
      );
    } else {
      if (!stat.isDirectory())
        throw new Error(`workspace path is not a directory: ${checkout}`);
      const entries = await fs.readdir(checkout);
      if (!entries.includes(".git"))
        throw new Error(`refusing non-Git directory: ${checkout}`);
    }
    const status = await this.status(orgSlug, site.slug);
    if (!sameRemote(status.remote, site.gitUrl)) {
      throw new Error(`workspace remote does not match Intern site: ${status.remote}`);
    }
    if (!contract) return status;
    const anchor = await this.openCheckoutAnchor(checkout);
    try {
      await this.assertCheckoutAnchor(checkout, anchor);
      await this.syncRuntimeAndBuild(checkout, site, contract, anchor);
    } finally {
      await anchor.handle.close();
    }
    return this.status(orgSlug, site.slug);
  }

  async status(orgSlug: string, siteSlug: string): Promise<WorkspaceStatus> {
    const checkout = this.checkoutPath(orgSlug, siteSlug);
    await this.assertContained(checkout);
    await this.validateRepository(checkout);
    const [
      { stdout: branch },
      { stdout: head },
      { stdout: porcelain },
      { stdout: remote },
      { stdout: pushRemotes },
    ] = await Promise.all([
      this.git(checkout, ["branch", "--show-current"]),
      this.git(checkout, ["rev-parse", "HEAD"]),
      this.git(checkout, ["status", "--porcelain=v1"]),
      this.git(checkout, ["remote", "get-url", "origin"]),
      this.git(checkout, ["remote", "get-url", "--all", "--push", "origin"]),
    ]);
    const changes = porcelain.trim() ? porcelain.trimEnd().split("\n") : [];
    const pushURLs = pushRemotes.trim().split("\n").filter(Boolean);
    if (pushURLs.length !== 1)
      throw new Error("Intern checkout must have exactly one push URL");
    return {
      path: checkout,
      branch: branch.trim(),
      head: head.trim(),
      dirty: changes.length > 0,
      changes,
      remote: remote.trim(),
      pushRemote: pushURLs[0],
    };
  }

  async validate(
    orgSlug: string,
    site: InternSite,
    contract: SiteRuntimeContract,
    options: { requireBuildOutput?: boolean } = {},
  ): Promise<SiteValidation> {
    const status = await this.status(orgSlug, site.slug);
    if (
      !sameRemote(status.remote, site.gitUrl) ||
      !sameRemote(status.pushRemote, site.gitUrl)
    ) {
      throw new Error(
        "refusing to validate a checkout with an unexpected Intern remote",
      );
    }
    return this.validateCommit(status.path, status.head, site, contract, options);
  }

  async publish(
    orgSlug: string,
    site: InternSite,
    contract: SiteRuntimeContract,
  ): Promise<PublishedWorkspace> {
    const before = await this.status(orgSlug, site.slug);
    if (before.dirty)
      throw new Error(
        `refusing to publish a dirty worktree: ${before.changes.join(", ")}`,
      );
    if (!before.branch) throw new Error("refusing to publish a detached HEAD");
    if (!sameRemote(before.remote, site.gitUrl))
      throw new Error("refusing to publish to an unexpected Git remote");
    if (!sameRemote(before.pushRemote, site.gitUrl))
      throw new Error("refusing to publish to an unexpected Git push URL");
    const validation = await this.validateCommit(
      before.path,
      before.head,
      site,
      contract,
      { requireBuildOutput: true },
    );
    if (!validation.valid) {
      throw new Error(
        `VALIDATION_FAILED: ${validation.issues.map((issue) => `${issue.code}${issue.path ? ` (${issue.path})` : ""}: ${issue.message}`).join("; ")}`,
      );
    }
    const after = await this.status(orgSlug, site.slug);
    if (
      after.head !== before.head ||
      after.branch !== before.branch ||
      after.dirty ||
      after.remote !== before.remote ||
      after.pushRemote !== before.pushRemote
    ) {
      throw new Error(
        "refusing to publish because the checkout changed during validation",
      );
    }
    await this.git(
      before.path,
      [
        "push",
        "--porcelain",
        "--",
        before.pushRemote,
        `${before.head}:refs/heads/${before.branch}`,
      ],
      await this.ssh?.command(site.gitUrl),
    );
    return { workspace: await this.status(orgSlug, site.slug), validation };
  }

  async testWorkingTree(
    orgSlug: string,
    site: InternSite,
    contract: SiteRuntimeContract,
    session?: InternSession,
  ): Promise<{ workspace: WorkspaceStatus; test: LocalSiteTest }> {
    const key = this.testKey(orgSlug, site.slug);
    return this.withTestLock(key, async () => {
      if (this.closing) throw new Error("local test manager is closing");
      const checkout = this.checkoutPath(orgSlug, site.slug);
      const anchor = await this.openCheckoutAnchor(checkout);
      try {
        const workspace = await this.status(orgSlug, site.slug);
        await this.assertCheckoutAnchor(checkout, anchor);
        if (
          !sameRemote(workspace.remote, site.gitUrl) ||
          !sameRemote(workspace.pushRemote, site.gitUrl)
        ) {
          throw new Error(
            "refusing to test a checkout with an unexpected Intern remote",
          );
        }
        await this.stopTestUnlocked(key);
        const temporary = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-test-")),
        );
        const snapshot = path.join(temporary, "site");
        try {
          await fs.mkdir(snapshot);
          await this.copyWorkingTree(workspace.path, snapshot, anchor);
          const buildIssues = await this.syncRuntimeAndBuild(
            workspace.path,
            site,
            contract,
            anchor,
            snapshot,
          );
          const workspaceAfter = await this.status(orgSlug, site.slug);
          const validation = await validateSite(snapshot, site, contract);
          if (buildIssues.length > 0) {
            validation.valid = false;
            validation.issues.push(...buildIssues);
          }
          if (!validation.valid) {
            await fs.rm(temporary, { recursive: true, force: true });
            return {
              workspace: workspaceAfter,
              test: {
                running: false,
                testedHead: workspaceAfter.head,
                source: "working-tree",
                validation,
              },
            };
          }
          try {
            const runtime = await startLocalPreviewRuntime(
              snapshot,
              contract,
              session ? localUserFromSession(session) : defaultLocalUser(),
            );
            if (this.closing) {
              await runtime.stop();
              await fs.rm(temporary, { recursive: true, force: true });
              throw new Error("local test manager is closing");
            }
            this.localTests.set(key, { runtime, temporary });
            return {
              workspace: workspaceAfter,
              test: {
                running: true,
                url: runtime.url,
                testedHead: workspaceAfter.head,
                source: "working-tree",
                validation,
              },
            };
          } catch (cause) {
            validation.valid = false;
            validation.checks.startup = false;
            validation.checks.http = false;
            validation.issues.push({
              code: "local_test_start_failed",
              severity: "error",
              message: cause instanceof Error ? cause.message : String(cause),
            });
            await fs.rm(temporary, { recursive: true, force: true });
            return {
              workspace: workspaceAfter,
              test: {
                running: false,
                testedHead: workspaceAfter.head,
                source: "working-tree",
                validation,
              },
            };
          }
        } catch (cause) {
          await fs.rm(temporary, { recursive: true, force: true });
          throw cause;
        }
      } finally {
        await anchor.handle.close();
      }
    });
  }

  async stopTestBySlug(siteSlug: string): Promise<boolean> {
    return this.withTestLifecycle(siteSlug, () =>
      this.stopTestBySlugUnlocked(siteSlug),
    );
  }

  async stopAllTests(): Promise<void> {
    await this.withLock(this.globalTestLocks, "all", () => this.stopAllTestsUnlocked());
  }

  async stopAllTestsThen<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLock(this.globalTestLocks, "all", async () => {
      await this.stopAllTestsUnlocked();
      return operation();
    });
  }

  private async stopAllTestsUnlocked(): Promise<void> {
    const slugs = new Set([
      ...this.lifecycleLocks.keys(),
      ...[...this.localTests.keys(), ...this.testLocks.keys()].map((key) =>
        key.slice(key.lastIndexOf("/") + 1),
      ),
    ]);
    await Promise.all(
      [...slugs].map((slug) =>
        this.withLock(this.lifecycleLocks, slug, () =>
          this.stopTestBySlugUnlocked(slug),
        ),
      ),
    );
  }

  private async stopTestBySlugUnlocked(siteSlug: string): Promise<boolean> {
    const keys = [
      ...new Set([...this.localTests.keys(), ...this.testLocks.keys()]),
    ].filter((key) => key.endsWith(`/${siteSlug}`));
    const stopped = await Promise.all(
      keys.map((key) => this.withTestLock(key, () => this.stopTestUnlocked(key))),
    );
    return stopped.some(Boolean);
  }

  async withTestLifecycle<T>(
    siteSlug: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!slugPattern.test(siteSlug)) throw new Error("invalid Intern site slug");
    return this.withLock(this.globalTestLocks, "all", () =>
      this.withLock(this.lifecycleLocks, siteSlug, operation),
    );
  }

  private async stopTestUnlocked(key: string): Promise<boolean> {
    const session = this.localTests.get(key);
    if (!session) return false;
    const errors: unknown[] = [];
    try {
      await session.runtime.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await fs.rm(session.temporary, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `failed to clean local preview ${key}`);
    }
    this.localTests.delete(key);
    return true;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.stopAllTests();
  }

  async clearSSHCertificate(): Promise<void> {
    await this.ssh?.clearCertificate();
  }

  checkoutPath(orgSlug: string, siteSlug: string): string {
    if (!slugPattern.test(orgSlug) || !slugPattern.test(siteSlug))
      throw new Error("invalid Intern org or site slug");
    const target = path.resolve(this.config.workspaceRoot, orgSlug, siteSlug);
    const relative = path.relative(this.config.workspaceRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("workspace path escapes configured root");
    return target;
  }

  private async assertContained(target: string): Promise<void> {
    await fs.mkdir(this.config.workspaceRoot, { recursive: true });
    const root = await fs.realpath(this.config.workspaceRoot);
    const real = await fs.realpath(target);
    const relative = path.relative(root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("workspace symlink escapes configured root");
  }

  private async validateRepository(checkout: string): Promise<void> {
    const [{ stdout: top }, { stdout: gitDirectory }] = await Promise.all([
      this.git(checkout, ["rev-parse", "--show-toplevel"]),
      this.git(checkout, ["rev-parse", "--absolute-git-dir"]),
    ]);
    if ((await fs.realpath(top.trim())) !== (await fs.realpath(checkout))) {
      throw new Error("checkout Git root does not match its workspace path");
    }
    await this.assertContained(gitDirectory.trim());
  }

  private async validateCommit(
    checkout: string,
    head: string,
    site: InternSite,
    contract: SiteRuntimeContract,
    options: { requireBuildOutput?: boolean } = {},
  ): Promise<SiteValidation> {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-commit-"));
    const archive = path.join(temporary, "site.tar");
    const snapshot = path.join(temporary, "site");
    try {
      await this.assertCommitWithinLimits(checkout, head);
      await fs.mkdir(snapshot);
      await this.git(checkout, [
        "archive",
        "--format=tar",
        `--output=${archive}`,
        "--",
        head,
      ]);
      await exec("tar", ["-xf", archive, "-C", snapshot], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const validation = await validateSite(snapshot, site, contract);
      if (options.requireBuildOutput) {
        const issue = await missingCommittedBuildOutput(snapshot);
        if (issue) {
          validation.valid = false;
          validation.issues.push(issue);
        }
      }
      return validation;
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  private async syncRuntimeAndBuild(
    checkout: string,
    site: InternSite,
    contract: SiteRuntimeContract,
    anchor: CheckoutAnchor,
    existingSnapshot?: string,
  ): Promise<ValidationIssue[]> {
    let temporary: string | undefined;
    const snapshot =
      existingSnapshot ??
      path.join(
        (temporary = await fs.realpath(
          await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-build-")),
        )),
        "site",
      );
    try {
      if (!existingSnapshot) {
        await fs.mkdir(snapshot);
        await this.copyWorkingTree(checkout, snapshot, anchor);
      }
      await this.upgradeProtectedFiles(snapshot, checkout, site, contract);
      const issues = await runLocalSiteBuild(snapshot);
      if (issues.length === 0) {
        await this.materializeGeneratedFiles(snapshot, checkout);
      }
      return issues;
    } finally {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  private async upgradeProtectedFiles(
    snapshot: string,
    checkout: string,
    site: InternSite,
    contract: SiteRuntimeContract,
  ): Promise<void> {
    for (const [name, template] of Object.entries(contract.protectedFiles)) {
      const current = renderProtectedFile(template, site.port);
      const snapshotPath = path.join(snapshot, name);
      const actual = await fs.readFile(snapshotPath, "utf8").catch(() => null);
      if (actual === null || actual === current) continue;
      if (!isAcceptedProtectedFile(name, actual, contract, site.port)) continue;
      await fs.writeFile(snapshotPath, current, {
        mode: name === "run-site.sh" ? 0o750 : 0o644,
      });
      const checkoutPath = path.join(checkout, name);
      const checkoutActual = await fs.readFile(checkoutPath, "utf8").catch(() => null);
      if (checkoutActual === actual) {
        await fs.writeFile(checkoutPath, current, {
          mode: name === "run-site.sh" ? 0o750 : 0o644,
        });
      }
    }
  }

  private async materializeGeneratedFiles(
    snapshot: string,
    checkout: string,
  ): Promise<void> {
    const dist = path.join(snapshot, "dist");
    if (
      await fs
        .stat(dist)
        .then((info) => info.isDirectory())
        .catch(() => false)
    ) {
      const destination = path.join(checkout, "dist");
      await fs.rm(destination, { recursive: true, force: true });
      await fs.cp(dist, destination, { recursive: true });
    }
    const lock = path.join(snapshot, "package-lock.json");
    if (
      await fs
        .stat(lock)
        .then((info) => info.isFile())
        .catch(() => false)
    ) {
      await fs.copyFile(lock, path.join(checkout, "package-lock.json"));
    }
  }

  private async copyWorkingTree(
    checkout: string,
    snapshot: string,
    anchor: CheckoutAnchor,
  ): Promise<void> {
    const { stdout } = await this.git(checkout, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    await this.assertCheckoutAnchor(checkout, anchor);
    const names = stdout.split("\0").filter(Boolean);
    if (names.length > maxCommitFiles)
      throw new Error(`VALIDATION_FAILED: local site exceeds ${maxCommitFiles} files`);
    let total = 0;
    for (const name of names) {
      const source = path.resolve(checkout, name);
      const relative = path.relative(checkout, source);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("VALIDATION_FAILED: unsafe working-tree path");
      const info = await fs.lstat(source).catch(() => null);
      if (!info) continue;
      await this.assertNoSymlinkedParents(checkout, relative);
      const destination = path.join(snapshot, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (info.isSymbolicLink()) {
        await fs.symlink(await fs.readlink(source), destination);
        continue;
      }
      const handle = await fs.open(
        source,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        const opened = await handle.stat();
        if (!opened.isFile())
          throw new Error(`VALIDATION_FAILED: unsupported working-tree entry: ${name}`);
        await this.assertCheckoutAnchor(checkout, anchor);
        const resolved = await fs.realpath(source);
        const resolvedRelative = path.relative(anchor.realPath, resolved);
        if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
          throw new Error(
            `VALIDATION_FAILED: working-tree path resolves outside the checkout: ${name}`,
          );
        }
        const resolvedInfo = await fs.stat(resolved);
        if (resolvedInfo.dev !== opened.dev || resolvedInfo.ino !== opened.ino) {
          throw new Error(
            `VALIDATION_FAILED: working-tree path changed while snapshotting: ${name}`,
          );
        }
        if (opened.size > maxFileBytes)
          throw new Error(
            `VALIDATION_FAILED: local site contains a file larger than ${maxFileBytes} bytes`,
          );
        total += opened.size;
        if (total > maxCommitBytes)
          throw new Error(
            `VALIDATION_FAILED: local site exceeds ${maxCommitBytes} bytes`,
          );
        const contents = await handle.readFile();
        const after = await handle.stat();
        if (
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          after.ctimeMs !== opened.ctimeMs
        ) {
          throw new Error(
            `VALIDATION_FAILED: working-tree file changed while snapshotting: ${name}`,
          );
        }
        await fs.writeFile(destination, contents, { mode: opened.mode & 0o777 });
      } finally {
        await handle.close();
      }
    }
  }

  private async openCheckoutAnchor(checkout: string): Promise<CheckoutAnchor> {
    const handle = await fs.open(
      checkout,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isDirectory()) throw new Error("workspace checkout is not a directory");
      const realPath = await fs.realpath(checkout);
      const anchor = { handle, realPath, dev: info.dev, ino: info.ino };
      await this.assertCheckoutAnchor(checkout, anchor);
      return anchor;
    } catch (cause) {
      await handle.close();
      throw cause;
    }
  }

  private async assertCheckoutAnchor(
    checkout: string,
    anchor: CheckoutAnchor,
  ): Promise<void> {
    const [info, realPath] = await Promise.all([
      fs.stat(checkout),
      fs.realpath(checkout),
    ]);
    if (
      info.dev !== anchor.dev ||
      info.ino !== anchor.ino ||
      realPath !== anchor.realPath
    ) {
      throw new Error(
        "VALIDATION_FAILED: workspace checkout changed while snapshotting",
      );
    }
  }

  private async assertNoSymlinkedParents(
    checkout: string,
    relative: string,
  ): Promise<void> {
    let current = checkout;
    for (const component of relative.split(path.sep).slice(0, -1)) {
      current = path.join(current, component);
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(
          `VALIDATION_FAILED: working-tree path has a symlinked parent: ${relative}`,
        );
      }
      if (!info.isDirectory()) {
        throw new Error(
          `VALIDATION_FAILED: working-tree path has a non-directory parent: ${relative}`,
        );
      }
    }
  }

  private testKey(orgSlug: string, siteSlug: string): string {
    return `${orgSlug}/${siteSlug}`;
  }

  private async withTestLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.withLock(this.testLocks, key, operation);
  }

  private async withLock<T>(
    locks: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  private async assertCommitWithinLimits(
    checkout: string,
    head: string,
  ): Promise<void> {
    const { stdout } = await this.git(checkout, ["ls-tree", "-rl", "-z", "--", head]);
    const records = stdout.split("\0").filter(Boolean);
    if (records.length > maxCommitFiles)
      throw new Error(`VALIDATION_FAILED: site commit exceeds ${maxCommitFiles} files`);
    let total = 0;
    for (const record of records) {
      const match = record.match(/^\d+\s+\w+\s+[0-9a-f]+\s+(\d+|-)\t/);
      if (!match)
        throw new Error("VALIDATION_FAILED: could not inspect site commit tree");
      if (match[1] === "-") continue;
      const size = Number(match[1]);
      if (size > maxFileBytes)
        throw new Error(
          `VALIDATION_FAILED: site commit contains a file larger than ${maxFileBytes} bytes`,
        );
      total += size;
      if (total > maxCommitBytes)
        throw new Error(
          `VALIDATION_FAILED: site commit exceeds ${maxCommitBytes} bytes`,
        );
    }
  }

  private git(cwd: string, args: string[], issuedSSHCommand?: string) {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    const sshCommand = issuedSSHCommand ?? this.config.gitSSHCommand ?? "ssh";
    return exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.sshCommand=${sshCommand}`,
        "-c",
        "protocol.ext.allow=never",
        ...args,
      ],
      {
        cwd,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: environment,
      },
    );
  }
}

function sameRemote(left: string, right: string): boolean {
  return normalizeRemote(left) === normalizeRemote(right);
}

function normalizeRemote(value: string): string {
  const raw = value.trim();
  const scp = raw.match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/);
  if (scp && !raw.includes("://")) {
    return `ssh|${scp[1] ?? ""}|${scp[2].toLowerCase()}|22|${cleanRepoPath(scp[3])}`;
  }
  try {
    const url = new URL(raw);
    const port = url.port || (url.protocol === "ssh:" ? "22" : "");
    return `${url.protocol}|${decodeURIComponent(url.username)}|${url.hostname.toLowerCase()}|${port}|${cleanRepoPath(url.pathname)}`;
  } catch {
    return `file||||${path.resolve(raw).replace(/\.git$/, "")}`;
  }
}

function cleanRepoPath(value: string): string {
  return value
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}
