import type { InternConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { CredentialStore, type OAuthCredentialRecord } from "./credential-store.js";
import { DeviceAuthorization, type OAuthCandidate } from "./device-authorization.js";

const refreshWindowMs = 60_000;

interface AuthorizationClient {
  authorize(timeoutMs?: number): Promise<OAuthCandidate>;
  refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthCandidate>;
}

interface AuthDependencies {
  env?: NodeJS.ProcessEnv;
  store?: CredentialStore;
  authorization?: AuthorizationClient;
  verifier?: (accessToken: string) => Promise<void>;
  now?: () => number;
}

export class AuthClient {
  private readonly config: InternConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly store: CredentialStore;
  private readonly authorization: AuthorizationClient;
  private readonly verifier: (accessToken: string) => Promise<void>;
  private readonly now: () => number;
  private readonly explicitToken: string | undefined;
  private readonly hasExplicitToken: boolean;

  constructor(
    configOrToken: InternConfig | string = loadConfig(),
    dependencies: AuthDependencies = {},
  ) {
    this.hasExplicitToken = typeof configOrToken === "string";
    this.explicitToken = typeof configOrToken === "string" ? configOrToken : undefined;
    this.config = typeof configOrToken === "string" ? loadConfig() : configOrToken;
    this.env = dependencies.env ?? process.env;
    const binding = {
      platformBaseURL: this.config.archAstroBaseURL,
      oauthClientID: this.config.oauthClientID,
    };
    this.store =
      dependencies.store ?? new CredentialStore(this.config.configRoot, binding);
    this.authorization =
      dependencies.authorization ??
      new DeviceAuthorization({
        ...binding,
        publishableKey: this.config.publishableKey,
      });
    this.verifier =
      dependencies.verifier ??
      (async () => {
        throw new Error("TryIntern authorization verification is not configured");
      });
    this.now = dependencies.now ?? Date.now;
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const override = this.overrideToken();
    if (override) return override;
    const stored = await this.store.read();
    signal?.throwIfAborted();
    if (!stored) {
      throw new Error("AUTH_REQUIRED: Intern is not connected; run setup again");
    }
    if (stored.kind === "legacy") return stored.accessToken;
    if (isComfortablyValid(stored.record, this.now())) {
      return stored.record.tokens.accessToken;
    }
    try {
      return await this.store.withRefreshLock(async (current) => {
        if (isComfortablyValid(current, this.now())) {
          return { result: current.tokens.accessToken };
        }
        const refreshed = signal
          ? await this.authorization.refresh(current.tokens.refreshToken, signal)
          : await this.authorization.refresh(current.tokens.refreshToken);
        return {
          result: refreshed.accessToken,
          record: recordFrom(refreshed),
        };
      }, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(
        `AUTH_REQUIRED: Intern session refresh failed; run setup again${errorMessage(error)}`,
      );
    }
  }

  async hasCredentials(): Promise<boolean> {
    if (this.overrideToken()) return true;
    return (await this.store.read()) !== null;
  }

  async authorize(timeoutMs = 300_000): Promise<string> {
    const candidate = await this.authorization.authorize(timeoutMs);
    await this.verifier(candidate.accessToken);
    await this.store.commit(candidate);
    return candidate.accessToken;
  }

  private overrideToken(): string | undefined {
    const value = this.hasExplicitToken
      ? this.explicitToken
      : this.env.INTERN_ACCESS_TOKEN;
    const token = value?.trim();
    return token || undefined;
  }
}

function isComfortablyValid(record: OAuthCredentialRecord, now: number): boolean {
  return record.tokens.expiresAtMs > now + refreshWindowMs;
}

function recordFrom(candidate: OAuthCandidate): OAuthCredentialRecord {
  return {
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? `: ${error.message}` : "";
}
