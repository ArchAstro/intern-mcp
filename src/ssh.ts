import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { InternAPI } from "./api.js";
import type { InternConfig } from "./config.js";

const exec = promisify(execFile);

export class SSHCredentialManager {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: InternConfig,
    private readonly api: InternAPI,
  ) {}

  async command(gitURL: string): Promise<string | undefined> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.commandUnlocked(gitURL);
    } finally {
      release();
    }
  }

  private async commandUnlocked(gitURL: string): Promise<string | undefined> {
    if (this.config.gitSSHCommand) return this.config.gitSSHCommand;
    if (path.isAbsolute(gitURL) || gitURL.startsWith("file://")) return undefined;
    const { host, username, port } = parseSSHRemote(gitURL);
    const directory = path.join(this.config.configRoot, "ssh");
    const privateKey = path.join(directory, "id_ed25519");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await exists(privateKey))) {
      await exec(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-C", "intern-mcp", "-f", privateKey],
        {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
    }
    await Promise.all([
      fs.chmod(privateKey, 0o600),
      fs.chmod(`${privateKey}.pub`, 0o600),
    ]);
    const publicKey = (await fs.readFile(`${privateKey}.pub`, "utf8")).trim();
    const credential = await this.api.mintSSHCertificate(publicKey);
    if (credential.username !== username)
      throw new Error("Intern SSH credential username does not match the Git remote");
    if (credential.expiresAt * 1000 <= Date.now() + 30_000)
      throw new Error("Intern returned an already-expiring SSH certificate");
    validatePublicLine(credential.certificate, "certificate");
    validatePublicLine(credential.hostPublicKey, "gateway host key");
    const certificate = `${privateKey}-cert.pub`;
    const knownHosts = path.join(directory, "known_hosts");
    const hostPattern = port === "22" ? host : `[${host}]:${port}`;
    await Promise.all([
      atomicWrite(certificate, `${credential.certificate.trim()}\n`, 0o600),
      atomicWrite(
        knownHosts,
        `${hostPattern} ${credential.hostPublicKey.trim()}\n`,
        0o600,
      ),
    ]);
    return [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `IdentityFile=${privateKey}`,
      "-o",
      `CertificateFile=${certificate}`,
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "StrictHostKeyChecking=yes",
    ]
      .map(shellQuote)
      .join(" ");
  }

  async clearCertificate(): Promise<void> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await fs.rm(path.join(this.config.configRoot, "ssh", "id_ed25519-cert.pub"), {
        force: true,
      });
    } finally {
      release();
    }
  }
}

function parseSSHRemote(raw: string): {
  username: string;
  host: string;
  port: string;
} {
  const scp = raw.trim().match(/^([^@/:]+)@([^/:]+):.+$/);
  if (scp && !raw.includes("://"))
    return { username: scp[1], host: scp[2].toLowerCase(), port: "22" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Intern Git remote is not SSH");
  }
  if (parsed.protocol !== "ssh:" || !parsed.username || !parsed.hostname)
    throw new Error("Intern Git remote is not canonical SSH");
  return {
    username: decodeURIComponent(parsed.username),
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "22",
  };
}

function validatePublicLine(value: string, label: string): void {
  const line = value.trim();
  if (
    !line ||
    line.length > 4096 ||
    line.includes("\n") ||
    line.includes("\r") ||
    !/^ssh-[a-z0-9@.-]+ [A-Za-z0-9+/=]+(?:\s.*)?$/.test(line)
  ) {
    throw new Error(`Intern returned an invalid SSH ${label}`);
  }
}

async function atomicWrite(
  target: string,
  contents: string,
  mode: number,
): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}`;
  await fs.writeFile(temporary, contents, { mode });
  await fs.rename(temporary, target);
  await fs.chmod(target, mode);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
