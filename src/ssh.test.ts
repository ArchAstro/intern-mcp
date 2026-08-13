import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import type { InternAPI, SSHCredential } from "./api.js";
import type { InternConfig } from "./config.js";
import { SSHCredentialManager } from "./ssh.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  ),
);

describe("SSHCredentialManager", () => {
  test("keeps the private key local and installs the requested certificate for Git", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-ssh-"));
    roots.push(root);
    const caKey = path.join(root, "ca");
    const hostKey = path.join(root, "host");
    await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", caKey]);
    await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    let requestedPublicKey = "";
    const api = {
      async mintSSHCertificate(publicKey: string): Promise<SSHCredential> {
        requestedPublicKey = publicKey;
        const publicPath = path.join(root, "requested.pub");
        await fs.writeFile(publicPath, `${publicKey}\n`, { mode: 0o600 });
        await exec("ssh-keygen", [
          "-q",
          "-s",
          caKey,
          "-I",
          "user-1",
          "-n",
          "stripe|org-1|admin|user-1",
          "-V",
          "+5m",
          publicPath,
        ]);
        return {
          certificate: (
            await fs.readFile(path.join(root, "requested-cert.pub"), "utf8")
          ).trim(),
          hostPublicKey: (await fs.readFile(`${hostKey}.pub`, "utf8")).trim(),
          username: "stripe",
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        };
      },
    } as InternAPI;
    const config: InternConfig = {
      internBaseURL: "https://tryintern.dev",
      archAstroBaseURL: "https://api.archastro.ai",
      workspaceRoot: path.join(root, "workspaces"),
      configRoot: path.join(root, "config"),
    };

    const command = await new SSHCredentialManager(config, api).command(
      "stripe@git.tryintern.dev:docs.git",
    );
    const privateKey = path.join(config.configRoot, "ssh", "id_ed25519");
    expect(requestedPublicKey).toMatch(/^ssh-ed25519 /);
    expect(requestedPublicKey).not.toContain(await fs.readFile(privateKey, "utf8"));
    expect(command).toContain("CertificateFile=");
    expect(command).toContain("StrictHostKeyChecking=yes");
    expect(
      await fs.readFile(path.join(config.configRoot, "ssh", "known_hosts"), "utf8"),
    ).toContain("git.tryintern.dev ssh-ed25519 ");
    expect((await fs.stat(privateKey)).mode & 0o777).toBe(0o600);
  });

  test("rejects a certificate issued for a different Git username", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-mcp-ssh-user-"));
    roots.push(root);
    const api = {
      async mintSSHCertificate(): Promise<SSHCredential> {
        return {
          certificate: "ssh-ed25519-cert-v01@openssh.com AAAA",
          hostPublicKey: "ssh-ed25519 AAAA",
          username: "other",
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        };
      },
    } as InternAPI;
    const config = {
      internBaseURL: "",
      archAstroBaseURL: "",
      workspaceRoot: path.join(root, "workspaces"),
      configRoot: path.join(root, "config"),
    };
    await expect(
      new SSHCredentialManager(config, api).command(
        "stripe@git.tryintern.dev:docs.git",
      ),
    ).rejects.toThrow("username");
  });
});
