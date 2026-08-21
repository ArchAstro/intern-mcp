import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { publicNPMRegistry, pullLatestInternSDK } from "./validation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test("pulls the public latest SDK and pins the resolved development dependency", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-sdk-install-"));
  roots.push(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    '{"private":true,"devDependencies":{"@archastro/intern-sdk":"0.0.1"}}\n',
  );
  const run = vi.fn(
    async (_command: string, _args: string[], options: { cwd: string }) => {
      await fs.writeFile(
        path.join(options.cwd, "package.json"),
        '{"private":true,"devDependencies":{"@archastro/intern-sdk":"0.2.3"}}\n',
      );
      await fs.writeFile(
        path.join(options.cwd, "package-lock.json"),
        `${JSON.stringify({ name: path.basename(options.cwd) })}\n`,
      );
      return { stdout: "", stderr: "" };
    },
  );

  await expect(pullLatestInternSDK(root, undefined, run as never)).resolves.toBe(
    "0.2.3",
  );
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0]).toBe("npm");
  expect(run.mock.calls[0]?.[1]).toEqual([
    "install",
    "--package-lock-only",
    "--save-dev",
    "--save-exact",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefer-online",
    `--@archastro:registry=${publicNPMRegistry}`,
    "@archastro/intern-sdk@latest",
  ]);
  expect(run.mock.calls[0]?.[2]).toMatchObject({
    timeout: 120_000,
  });
  expect(run.mock.calls[0]?.[2]?.cwd).not.toBe(root);
  expect(path.basename(run.mock.calls[0]?.[2]?.cwd ?? "")).toBe(path.basename(root));
  await expect(fs.readFile(path.join(root, "package-lock.json"), "utf8")).resolves.toBe(
    `${JSON.stringify({ name: path.basename(root) })}\n`,
  );
  await expect(fs.stat(path.join(root, "node_modules"))).rejects.toThrow();
});

test("rejects symlinked package metadata without mutating its external target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-sdk-install-"));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "intern-sdk-external-"));
  roots.push(root, external);
  const externalPackage = path.join(external, "package.json");
  const original = '{"private":true}\n';
  await fs.writeFile(externalPackage, original);
  await fs.symlink(externalPackage, path.join(root, "package.json"));
  const run = vi.fn();

  await expect(pullLatestInternSDK(root, undefined, run as never)).rejects.toThrow(
    "SDK_INSTALL_FAILED: package.json must be a regular file",
  );

  expect(run).not.toHaveBeenCalled();
  await expect(fs.readFile(externalPackage, "utf8")).resolves.toBe(original);
});

test("fails prepare loudly when the latest SDK cannot be resolved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-sdk-install-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "package.json"), '{"private":true}\n');

  await expect(
    pullLatestInternSDK(root, undefined, (async () => {
      throw new Error("registry unavailable");
    }) as never),
  ).rejects.toThrow(
    "SDK_INSTALL_FAILED: could not resolve @archastro/intern-sdk@latest from public npm",
  );
});
