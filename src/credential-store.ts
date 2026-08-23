import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OAuthCandidate } from "./device-authorization.js";

export interface OAuthCredentialRecord {
  version: 1;
  platformBaseURL: string;
  oauthClientID: string;
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAtMs: number;
    scope: string;
  };
}

export type StoredCredential =
  | { kind: "oauth"; record: OAuthCredentialRecord }
  | { kind: "legacy"; accessToken: string };

interface CredentialBinding {
  platformBaseURL: string;
  oauthClientID: string;
}

interface RefreshResult<T> {
  result: T;
  record?: OAuthCredentialRecord;
}

interface CredentialStoreDependencies {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  chmod?: (file: string, mode: number) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  remove?: (file: string, options?: { force?: boolean }) => Promise<void>;
}

interface FileSnapshot {
  contents: Buffer;
  mode: number;
}

const lockPollMs = 100;
const lockTimeoutMs = 30_000;
const malformedGraceMs = 500;
const intentPrefix = ".refresh-intent.";
const intentSuffix = ".json";

interface LockMetadata {
  pid: number;
  createdAtMs: number;
  token: string;
}

interface LockObservation {
  metadata: LockMetadata | null;
  fingerprint: string;
}

export class CredentialStore {
  private readonly configRoot: string;
  private readonly binding: CredentialBinding;
  private readonly now: () => number;
  private readonly sleep: ((milliseconds: number) => Promise<void>) | undefined;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly chmod: (file: string, mode: number) => Promise<void>;
  private readonly rename: (from: string, to: string) => Promise<void>;
  private readonly remove: (
    file: string,
    options?: { force?: boolean },
  ) => Promise<void>;
  private temporarySequence = 0;

  constructor(
    configRoot: string,
    binding: CredentialBinding,
    dependencies: CredentialStoreDependencies = {},
  ) {
    this.configRoot = configRoot;
    this.binding = binding;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep;
    this.isProcessAlive = dependencies.isProcessAlive ?? processIsAlive;
    this.chmod = dependencies.chmod ?? fs.chmod;
    this.rename = dependencies.rename ?? fs.rename;
    this.remove = dependencies.remove ?? fs.rm;
  }

  async read(): Promise<StoredCredential | null> {
    const oauth = await this.readOAuth();
    if (oauth) return { kind: "oauth", record: oauth };
    try {
      const accessToken = (await fs.readFile(this.legacyFile(), "utf8")).trim();
      if (!accessToken) {
        throw new Error("Legacy Intern credentials are empty; run setup again");
      }
      return { kind: "legacy", accessToken };
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async readOAuth(): Promise<OAuthCredentialRecord | null> {
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(this.credentialsFile(), "utf8"));
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw setupAgain("Stored Intern credentials are corrupt");
    }
    const record = parseRecord(value);
    if (!record) throw setupAgain("Stored Intern credentials are corrupt");
    if (record.platformBaseURL !== this.binding.platformBaseURL) {
      throw setupAgain("Stored Intern credentials belong to a different Platform");
    }
    if (record.oauthClientID !== this.binding.oauthClientID) {
      throw setupAgain("Stored Intern credentials belong to a different OAuth client");
    }
    return record;
  }

  async commit(candidate: OAuthCandidate, signal?: AbortSignal): Promise<void> {
    if (
      candidate.platformBaseURL !== this.binding.platformBaseURL ||
      candidate.oauthClientID !== this.binding.oauthClientID
    ) {
      throw setupAgain("Refusing to store Intern credentials for a different issuer");
    }
    const record: OAuthCredentialRecord = {
      version: 1,
      platformBaseURL: candidate.platformBaseURL,
      oauthClientID: candidate.oauthClientID,
      tokens: {
        accessToken: candidate.accessToken,
        refreshToken: candidate.refreshToken,
        expiresAtMs: candidate.expiresAtMs,
        scope: candidate.scope,
      },
    };
    await this.withCredentialLock(() => this.writeRecordUnlocked(record), signal);
  }

  async replaceWithLegacy(accessToken: string, signal?: AbortSignal): Promise<void> {
    const token = accessToken.trim();
    if (!token) throw new Error("Refusing to store an empty Intern access token");
    await this.withCredentialLock(async () => {
      const previousLegacy = await snapshotFile(this.legacyFile());
      await this.writeLegacy(token);
      try {
        await this.remove(this.credentialsFile(), { force: true });
      } catch (error) {
        await this.restoreLegacy(previousLegacy);
        throw error;
      }
    }, signal);
  }

  private async writeRecordUnlocked(record: OAuthCredentialRecord): Promise<void> {
    const parsed = parseRecord(record);
    if (!parsed) throw new Error("Refusing to write invalid Intern credentials");
    if (record.platformBaseURL !== this.binding.platformBaseURL) {
      throw setupAgain("Refusing credentials for a different Platform");
    }
    if (record.oauthClientID !== this.binding.oauthClientID) {
      throw setupAgain("Refusing credentials for a different OAuth client");
    }
    await this.ensureRoot();
    const destination = this.credentialsFile();
    const temporary = path.join(
      this.configRoot,
      `.credentials.${process.pid}.${this.now()}.${this.temporarySequence++}`,
    );
    try {
      await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await this.chmod(temporary, 0o600);
      await this.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async withRefreshLock<T>(
    callback: (current: OAuthCredentialRecord) => Promise<RefreshResult<T>>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.withCredentialLock(async () => {
      const current = await this.readOAuth();
      if (!current) throw setupAgain("Intern OAuth credentials are missing");
      const refreshed = await callback(current);
      if (refreshed.record) await this.writeRecordUnlocked(refreshed.record);
      return refreshed.result;
    }, signal);
  }

  private async withCredentialLock<T>(
    callback: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquireRefreshLock(signal);
    try {
      signal?.throwIfAborted();
      return await callback();
    } finally {
      await release();
    }
  }

  private async acquireRefreshLock(signal?: AbortSignal): Promise<() => Promise<void>> {
    signal?.throwIfAborted();
    await this.ensureRoot();
    signal?.throwIfAborted();
    const lockFile = path.join(this.configRoot, "refresh.lock");
    const startedAt = this.now();
    const intent = await this.createIntent();
    let leaderSinceMs: number | undefined;
    let malformedLock: { fingerprint: string; firstObservedAtMs: number } | undefined;
    try {
      signal?.throwIfAborted();
      while (this.now() - startedAt < lockTimeoutMs) {
        signal?.throwIfAborted();
        const leader = (await this.liveIntents())[0];
        if (leader?.token !== intent.token) {
          leaderSinceMs = undefined;
          malformedLock = undefined;
          await this.pollDelay(startedAt, signal);
          continue;
        }
        if (leaderSinceMs === undefined) {
          leaderSinceMs = this.now();
          await this.pollDelay(startedAt, signal);
          continue;
        }

        const observed = await readLock(lockFile);
        if (!observed) {
          if (await this.publishLock(lockFile, intent)) {
            let released = false;
            const release = async () => {
              if (released) return;
              released = true;
              try {
                const current = await readLock(lockFile);
                if (current?.metadata?.token === intent.token) {
                  await this.quarantineIfUnchanged(lockFile, current, intent.token);
                }
              } finally {
                await fs.rm(this.intentFile(intent.token), { force: true });
              }
            };
            try {
              signal?.throwIfAborted();
              return release;
            } catch (error) {
              await release();
              throw error;
            }
          }
          continue;
        }

        if (observed.metadata) {
          malformedLock = undefined;
          if (!this.processAlive(observed.metadata.pid)) {
            const current = await readLock(lockFile);
            if (current?.fingerprint === observed.fingerprint) {
              await this.quarantineIfUnchanged(lockFile, observed, intent.token);
            }
            continue;
          }
        } else if (malformedLock?.fingerprint !== observed.fingerprint) {
          malformedLock = {
            fingerprint: observed.fingerprint,
            firstObservedAtMs: this.now(),
          };
        } else if (this.now() - malformedLock.firstObservedAtMs >= malformedGraceMs) {
          const current = await readLock(lockFile);
          if (current?.fingerprint === observed.fingerprint) {
            await this.quarantineIfUnchanged(lockFile, observed, intent.token);
          }
          malformedLock = undefined;
          continue;
        }
        await this.pollDelay(startedAt, signal);
      }
    } catch (error) {
      await fs.rm(this.intentFile(intent.token), { force: true });
      throw error;
    }
    await fs.rm(this.intentFile(intent.token), { force: true });
    throw new Error("timed out waiting for credential refresh; run setup again");
  }

  private async createIntent(): Promise<LockMetadata> {
    const intent = {
      pid: process.pid,
      createdAtMs: this.now(),
      token: randomUUID(),
    };
    const destination = this.intentFile(intent.token);
    const temporary = `${destination}.pending`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(intent)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, destination);
      return intent;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async liveIntents(): Promise<LockMetadata[]> {
    const entries = await fs.readdir(this.configRoot);
    const intents: LockMetadata[] = [];
    await Promise.all(
      entries
        .filter(
          (entry) => entry.startsWith(intentPrefix) && entry.endsWith(intentSuffix),
        )
        .map(async (entry) => {
          const file = path.join(this.configRoot, entry);
          const metadata = await readMetadataFile(file);
          if (
            !metadata ||
            entry !== `${intentPrefix}${metadata.token}${intentSuffix}`
          ) {
            const stat = await fs.stat(file).catch(() => null);
            if (stat && this.now() - stat.mtimeMs >= malformedGraceMs) {
              await fs.rm(file, { force: true });
            }
            return;
          }
          if (!this.processAlive(metadata.pid)) {
            await fs.rm(file, { force: true });
            return;
          }
          intents.push(metadata);
        }),
    );
    return intents.sort(
      (left, right) =>
        left.createdAtMs - right.createdAtMs || left.token.localeCompare(right.token),
    );
  }

  private async publishLock(
    lockFile: string,
    metadata: LockMetadata,
  ): Promise<boolean> {
    const temporary = path.join(this.configRoot, `.refresh-owner.${metadata.token}`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(metadata)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.chmod(temporary, 0o600);
      try {
        await fs.link(temporary, lockFile);
        return true;
      } catch (error) {
        if (hasCode(error, "EEXIST")) return false;
        throw error;
      }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async quarantineIfUnchanged(
    lockFile: string,
    observed: LockObservation,
    intentToken: string,
  ): Promise<boolean> {
    const quarantine = path.join(
      this.configRoot,
      `.refresh-quarantine.${intentToken}.${randomUUID()}`,
    );
    try {
      await fs.rename(lockFile, quarantine);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
    const moved = await readLock(quarantine);
    if (moved?.fingerprint === observed.fingerprint) {
      await fs.rm(quarantine, { force: true });
      return true;
    }
    try {
      await fs.link(quarantine, lockFile);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    } finally {
      await fs.rm(quarantine, { force: true });
    }
    return false;
  }

  private async pollDelay(startedAt: number, signal?: AbortSignal): Promise<void> {
    const milliseconds = Math.min(lockPollMs, lockTimeoutMs - (this.now() - startedAt));
    await (this.sleep
      ? waitForInjectedSleep(this.sleep, milliseconds, signal)
      : delay(milliseconds, signal));
  }

  private processAlive(pid: number): boolean {
    return pid === process.pid || this.isProcessAlive(pid);
  }

  private intentFile(token: string): string {
    return path.join(this.configRoot, `${intentPrefix}${token}${intentSuffix}`);
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.configRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(this.configRoot, 0o700);
  }

  private async writeLegacy(accessToken: string): Promise<void> {
    const temporary = path.join(
      this.configRoot,
      `.access-token.${process.pid}.${this.now()}.${this.temporarySequence++}`,
    );
    try {
      await fs.writeFile(temporary, `${accessToken}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await this.chmod(temporary, 0o600);
      await this.rename(temporary, this.legacyFile());
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async restoreLegacy(snapshot: FileSnapshot | null): Promise<void> {
    if (!snapshot) {
      await this.remove(this.legacyFile(), { force: true });
      return;
    }
    const temporary = path.join(
      this.configRoot,
      `.access-token-restore.${process.pid}.${this.now()}.${this.temporarySequence++}`,
    );
    try {
      await fs.writeFile(temporary, snapshot.contents, {
        mode: snapshot.mode,
        flag: "wx",
      });
      await this.chmod(temporary, snapshot.mode);
      await this.rename(temporary, this.legacyFile());
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  private credentialsFile(): string {
    return path.join(this.configRoot, "credentials.json");
  }

  private legacyFile(): string {
    return path.join(this.configRoot, "access-token");
  }
}

async function snapshotFile(file: string): Promise<FileSnapshot | null> {
  try {
    const [contents, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
    return { contents, mode: stat.mode & 0o777 };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function parseRecord(value: unknown): OAuthCredentialRecord | null {
  if (!isObject(value) || value.version !== 1) return null;
  if (
    typeof value.platformBaseURL !== "string" ||
    !value.platformBaseURL ||
    typeof value.oauthClientID !== "string" ||
    !value.oauthClientID ||
    !isObject(value.tokens)
  ) {
    return null;
  }
  const tokens = value.tokens;
  if (
    typeof tokens.accessToken !== "string" ||
    !tokens.accessToken ||
    typeof tokens.refreshToken !== "string" ||
    !tokens.refreshToken ||
    typeof tokens.expiresAtMs !== "number" ||
    !Number.isFinite(tokens.expiresAtMs) ||
    typeof tokens.scope !== "string" ||
    !tokens.scope
  ) {
    return null;
  }
  return value as unknown as OAuthCredentialRecord;
}

async function readLock(file: string): Promise<LockObservation | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const [contents, stat] = await Promise.all([
      handle.readFile("utf8"),
      handle.stat(),
    ]);
    return {
      metadata: parseLockMetadata(contents),
      fingerprint: createHash("sha256")
        .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:`)
        .update(contents)
        .digest("hex"),
    };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readMetadataFile(file: string): Promise<LockMetadata | null> {
  try {
    return parseLockMetadata(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    return null;
  }
}

function parseLockMetadata(contents: string): LockMetadata | null {
  try {
    const value: unknown = JSON.parse(contents);
    return isObject(value) &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.createdAtMs === "number" &&
      Number.isFinite(value.createdAtMs) &&
      typeof value.token === "string" &&
      value.token.length > 0
      ? {
          pid: Number(value.pid),
          createdAtMs: value.createdAtMs,
          token: value.token,
        }
      : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function waitForInjectedSleep(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(milliseconds);
  signal.throwIfAborted();
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const timer = setTimeout(() => finish(resolve), milliseconds);
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function setupAgain(message: string): Error {
  return new Error(`${message}; run setup again`);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
