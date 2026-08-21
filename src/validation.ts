import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  isAcceptedProtectedFile,
  type InternSite,
  type SiteRuntimeContract,
} from "./api.js";

const exec = promisify(execFile);
export const publicNPMRegistry = "https://registry.npmjs.org";

export interface ValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface SiteValidation {
  valid: boolean;
  contractVersion: string;
  siteType: string;
  checks: {
    files: boolean;
    package: boolean;
    syntax: boolean;
    startup: boolean;
    http: boolean;
  };
  issues: ValidationIssue[];
}

export interface RunningSiteRuntime {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export async function validateSite(
  checkout: string,
  site: InternSite,
  contract: SiteRuntimeContract,
): Promise<SiteValidation> {
  const issues: ValidationIssue[] = [];
  const checks = {
    files: false,
    package: false,
    syntax: false,
    startup: false,
    http: false,
  };
  if (!Number.isInteger(site.port) || site.port < 1 || site.port > 65_535) {
    issues.push(error("invalid_site_metadata", "Intern returned an invalid site port"));
  }
  const contractPaths = [
    ...contract.requiredFiles,
    ...Object.keys(contract.protectedFiles),
    contract.entrypoint,
  ];
  if (
    contract.runtime !== "node" ||
    contract.launchCommand.length !== 2 ||
    contract.launchCommand[0] !== "node" ||
    contract.launchCommand[1] !== contract.entrypoint
  ) {
    issues.push(
      error(
        "invalid_runtime_contract",
        "Intern returned an unsupported runtime launch contract",
      ),
    );
  }
  if (contractPaths.some((value) => !safeRelativePath(value))) {
    issues.push(
      error(
        "invalid_runtime_contract",
        "Intern returned a runtime contract containing an unsafe path",
      ),
    );
  }
  if (!contract.siteTypes.includes(site.siteType)) {
    issues.push(
      error(
        "unsupported_site_type",
        `Intern runtime ${contract.version} does not support site type ${site.siteType}`,
      ),
    );
  }

  const entries = await walk(checkout, checkout, issues);
  if (!issues.some((issue) => issue.code === "invalid_runtime_contract")) {
    for (const required of contract.requiredFiles) {
      const info = await fs.lstat(path.join(checkout, required)).catch(() => null);
      if (!entries.has(required) || !info)
        issues.push(
          error(
            "missing_required_file",
            `Required runtime file is missing: ${required}`,
            required,
          ),
        );
      else if (!info.isFile())
        issues.push(
          error(
            "required_file_not_regular",
            `Required runtime path must be a regular file: ${required}`,
            required,
          ),
        );
      else if (required === "run-site.sh" && (info.mode & 0o111) === 0)
        issues.push(
          error(
            "launcher_not_executable",
            "run-site.sh must retain its executable Git mode",
            required,
          ),
        );
    }
    for (const name of Object.keys(contract.protectedFiles)) {
      const actual = await fs
        .readFile(path.join(checkout, name), "utf8")
        .catch(() => null);
      if (
        actual !== null &&
        !isAcceptedProtectedFile(name, actual, contract, site.port)
      ) {
        issues.push(
          error(
            "protected_file_changed",
            `${name} is owned by the Intern runtime and must not be modified`,
            name,
          ),
        );
      }
    }
  }
  checks.files = !issues.some((issue) =>
    [
      "unsupported_file_type",
      "symlink_not_supported",
      "missing_required_file",
      "required_file_not_regular",
      "launcher_not_executable",
      "protected_file_changed",
    ].includes(issue.code),
  );

  const packagePath = path.join(checkout, "package.json");
  try {
    const packageJSON = JSON.parse(await fs.readFile(packagePath, "utf8")) as Record<
      string,
      unknown
    >;
    const runtimeDependencies = [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ].flatMap((field) => Object.keys(asRecord(packageJSON[field])));
    if (!contract.packageInstall && runtimeDependencies.length > 0) {
      issues.push(
        error(
          "package_install_unsupported",
          `Intern does not install packages; remove runtime dependencies: ${runtimeDependencies.join(", ")}`,
          "package.json",
        ),
      );
    } else {
      checks.package = true;
    }
  } catch (cause) {
    issues.push(
      error(
        "invalid_package_json",
        `package.json is not valid JSON: ${message(cause)}`,
        "package.json",
      ),
    );
  }

  if (!issues.some((issue) => issue.code === "invalid_runtime_contract")) {
    for (const source of [...entries].filter((name) => /\.(?:mjs|js)$/.test(name))) {
      const info = await fs.lstat(path.join(checkout, source)).catch(() => null);
      if (!info?.isFile()) continue;
      try {
        await exec(process.execPath, ["--check", path.join(checkout, source)], {
          cwd: checkout,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
      } catch (cause) {
        issues.push(error("javascript_syntax_error", message(cause), source));
      }
    }
    checks.syntax = !issues.some((issue) => issue.code === "javascript_syntax_error");
  }

  if (!issues.some((issue) => issue.severity === "error")) {
    const port = await availablePort(contract.listenHost);
    const smoke = await smokeTest(checkout, contract, port);
    checks.startup = smoke.started;
    checks.http = smoke.http;
    issues.push(...smoke.issues);
  }

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    contractVersion: contract.version,
    siteType: site.siteType,
    checks,
    issues,
  };
}

async function walk(
  root: string,
  directory: string,
  issues: ValidationIssue[],
  entries = new Set<string>(),
): Promise<Set<string>> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    entries.add(relative);
    if (entry.isSymbolicLink())
      issues.push(
        error(
          "symlink_not_supported",
          "Intern site repositories may not contain symbolic links",
          relative,
        ),
      );
    else if (entry.isDirectory()) await walk(root, absolute, issues, entries);
    else if (!entry.isFile())
      issues.push(
        error(
          "unsupported_file_type",
          "Intern site repositories may contain only regular files and directories",
          relative,
        ),
      );
  }
  return entries;
}

async function smokeTest(
  checkout: string,
  contract: SiteRuntimeContract,
  port: number,
) {
  const issues: ValidationIssue[] = [];
  const sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "intern-site-validation-")),
  );
  let running: RunningSiteRuntime | undefined;
  try {
    await fs.cp(checkout, sandbox, {
      recursive: true,
      filter: (source) => source === checkout || path.basename(source) !== ".git",
    });
    running = await startSiteRuntime(sandbox, contract, port);
  } catch (cause) {
    issues.push(error("site_did_not_start", message(cause), contract.entrypoint));
  } finally {
    await running?.stop();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
  return { started: Boolean(running), http: Boolean(running), issues };
}

export async function runLocalSiteBuild(root: string): Promise<ValidationIssue[]> {
  const packagePath = path.join(root, "package.json");
  let packageJSON: Record<string, unknown>;
  try {
    packageJSON = JSON.parse(await fs.readFile(packagePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return [];
  }
  const runtimeDependencies = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ].flatMap((field) => Object.keys(asRecord(packageJSON[field])));
  if (runtimeDependencies.length > 0) return [];
  const installable = Object.keys({
    ...asRecord(packageJSON.dependencies),
    ...asRecord(packageJSON.devDependencies),
    ...asRecord(packageJSON.optionalDependencies),
  });
  const environment = npmEnvironment(root);
  const nodeModules = path.join(root, "node_modules");
  const removeInstalledModules =
    installable.length > 0 &&
    !(await fs
      .stat(nodeModules)
      .then(() => true)
      .catch(() => false));
  try {
    if (installable.length > 0) {
      const lockExists = await fs
        .stat(path.join(root, "package-lock.json"))
        .then((info) => info.isFile())
        .catch(() => false);
      try {
        await exec(
          "npm",
          [
            lockExists ? "ci" : "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
          ],
          {
            cwd: root,
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
            env: environment,
          },
        );
      } catch (cause) {
        return [
          error(
            "local_package_install_failed",
            `Local package install failed: ${message(cause)}`,
            "package.json",
          ),
        ];
      }
    }
    if (typeof asRecord(packageJSON.scripts).build !== "string") return [];
    try {
      await exec("npm", ["run", "build"], {
        cwd: root,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: environment,
      });
    } catch (cause) {
      return [
        error(
          "local_build_failed",
          `Local site build failed: ${message(cause)}`,
          "package.json",
        ),
      ];
    }
    return [];
  } finally {
    if (removeInstalledModules) {
      await fs.rm(nodeModules, { recursive: true, force: true });
    }
  }
}

export async function pullLatestInternSDK(
  root: string,
  packageSpec = "@archastro/intern-sdk@latest",
  run: typeof exec = exec,
): Promise<string> {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "intern-sdk-npm-"));
  const sandbox = path.join(sandboxRoot, path.basename(root));
  await fs.mkdir(sandbox);
  try {
    const packageSource = await readRegularPackageFile(root, "package.json", true);
    const lockSource = await readRegularPackageFile(root, "package-lock.json", false);
    await fs.writeFile(path.join(sandbox, "package.json"), packageSource.contents);
    if (lockSource) {
      await fs.writeFile(path.join(sandbox, "package-lock.json"), lockSource.contents);
    }

    try {
      await run(
        "npm",
        [
          "install",
          "--package-lock-only",
          "--save-dev",
          "--save-exact",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--prefer-online",
          `--@archastro:registry=${publicNPMRegistry}`,
          packageSpec,
        ],
        {
          cwd: sandbox,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
          env: npmEnvironment(sandbox),
        },
      );
    } catch (cause) {
      throw new Error(
        `SDK_INSTALL_FAILED: could not resolve ${packageSpec} from public npm`,
        { cause },
      );
    }

    const resolvedPackage = await readRegularPackageFile(sandbox, "package.json", true);
    const resolvedLock = await readRegularPackageFile(
      sandbox,
      "package-lock.json",
      true,
    );
    const packageJSON = JSON.parse(resolvedPackage.contents.toString("utf8")) as {
      devDependencies?: Record<string, unknown>;
    };
    const pinned = packageJSON.devDependencies?.["@archastro/intern-sdk"];
    if (
      typeof pinned !== "string" ||
      pinned === "latest" ||
      pinned.endsWith("@latest")
    ) {
      throw new Error("SDK_INSTALL_FAILED: npm did not pin @archastro/intern-sdk");
    }

    await writeAtomicPackageFile(
      root,
      "package-lock.json",
      resolvedLock.contents,
      lockSource?.mode ?? 0o644,
    );
    await writeAtomicPackageFile(
      root,
      "package.json",
      resolvedPackage.contents,
      packageSource.mode,
    );
    return pinned;
  } finally {
    await fs.rm(sandboxRoot, { recursive: true, force: true });
  }
}

async function readRegularPackageFile(
  root: string,
  name: "package.json" | "package-lock.json",
  required: true,
): Promise<{ contents: Buffer; mode: number }>;
async function readRegularPackageFile(
  root: string,
  name: "package.json" | "package-lock.json",
  required: false,
): Promise<{ contents: Buffer; mode: number } | undefined>;
async function readRegularPackageFile(
  root: string,
  name: "package.json" | "package-lock.json",
  required: boolean,
): Promise<{ contents: Buffer; mode: number } | undefined> {
  const target = path.join(root, name);
  const before = await fs.lstat(target).catch((cause: NodeJS.ErrnoException) => {
    if (!required && cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (!before) return undefined;
  if (!before.isFile()) {
    throw new Error(`SDK_INSTALL_FAILED: ${name} must be a regular file`);
  }
  const handle = await fs.open(target, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`SDK_INSTALL_FAILED: ${name} changed during SDK resolution`);
    }
    return { contents: await handle.readFile(), mode: before.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function writeAtomicPackageFile(
  root: string,
  name: "package.json" | "package-lock.json",
  contents: Buffer,
  mode: number,
): Promise<void> {
  const temporary = path.join(root, `.intern-${randomUUID()}-${name}`);
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, path.join(root, name));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function npmEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("npm_")),
    ),
    HOME: root,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
}

export async function missingCommittedBuildOutput(
  root: string,
): Promise<ValidationIssue | undefined> {
  let packageJSON: Record<string, unknown>;
  try {
    packageJSON = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof asRecord(packageJSON.scripts).build !== "string") return undefined;
  const distIndex = await fs
    .stat(path.join(root, "dist", "index.html"))
    .catch(() => null);
  if (distIndex?.isFile()) return undefined;
  return error(
    "build_output_missing",
    "This site has a local build script. intern_test_site writes dist/; commit dist/ before validate or publish.",
    "dist/index.html",
  );
}

export async function startSiteRuntime(
  checkout: string,
  contract: SiteRuntimeContract,
  requestedPort?: number,
): Promise<RunningSiteRuntime> {
  const port = requestedPort ?? (await availablePort(contract.listenHost));
  const readinessName = `.intern-mcp-ready-${randomUUID()}`;
  const readinessBody = randomUUID();
  await fs.writeFile(path.join(checkout, readinessName), readinessBody, {
    mode: 0o600,
  });
  let stderr = "";
  const permissionArgs =
    process.allowedNodeEnvironmentFlags.has("--permission") &&
    process.allowedNodeEnvironmentFlags.has("--allow-net")
      ? [
          "--permission",
          `--allow-fs-read=${checkout}/**`,
          `--allow-fs-write=${checkout}/**`,
          "--allow-net",
        ]
      : [];
  const child = spawn(process.execPath, [...permissionArgs, contract.entrypoint], {
    cwd: checkout,
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      HOME: checkout,
      NODE_ENV: "production",
      [contract.portEnvironmentVariable]: String(port),
      TMPDIR: os.tmpdir(),
      PATH: process.env.PATH ?? "",
      LANG: process.env.LANG ?? "C",
    },
  });
  let childError: Error | null = null;
  child.once("error", (cause) => {
    childError = cause;
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) stderr += String(chunk);
  });
  const stop = async () => {
    killTree(child.pid, "SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        killTree(child.pid, "SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  try {
    const deadline = Date.now() + contract.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (childError || child.exitCode !== null) break;
      let response: { statusCode: number; body: string };
      try {
        response = await httpGet(contract.listenHost, port, `/${readinessName}`);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (
        response.statusCode >= 200 &&
        response.statusCode < 400 &&
        response.body === readinessBody
      ) {
        return { url: `http://${contract.listenHost}:${port}`, port, stop };
      }
      await stop();
      throw new Error(`Unexpected server answered on ${contract.listenHost}:${port}`);
    }
    await stop();
    throw new Error(
      `Site did not listen on ${contract.listenHost}:${port} within ${contract.startupTimeoutMs}ms${stderr ? `: ${stderr.trim()}` : ""}`,
    );
  } finally {
    await fs.rm(path.join(checkout, readinessName), { force: true });
  }
}

function availablePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function httpGet(
  host: string,
  port: number,
  requestPath: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: requestPath }, (response) => {
      const statusCode = response.statusCode ?? 0;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096)
          request.destroy(new Error("readiness response exceeded limit"));
      });
      response.once("end", () => resolve({ statusCode, body }));
    });
    const timer = setTimeout(
      () => request.destroy(new Error("request timed out")),
      500,
    );
    request.once("close", () => clearTimeout(timer));
    request.once("error", reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value) || value.includes("\\")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== ".." && !normalized.startsWith("../");
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // The process may have exited between the status check and signal.
  }
}

function error(code: string, message: string, filePath?: string): ValidationIssue {
  return { code, severity: "error", message, ...(filePath ? { path: filePath } : {}) };
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
