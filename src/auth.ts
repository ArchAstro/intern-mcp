import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { InternConfig } from "./config.js";

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";

interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

interface PendingAuthorization {
  deviceCode: string;
  userCode: string;
  verificationURI: string;
  verificationURIComplete: string;
  expiresAt: number;
  intervalSeconds: number;
}

interface StoredAuth {
  version: 1;
  tokens?: Tokens;
  pending?: PendingAuthorization;
}

export interface LoginInstructions {
  userCode: string;
  verificationURI: string;
  verificationURIComplete: string;
  expiresAt: number;
}

export class AuthClient {
  private refreshInFlight?: Promise<string>;

  constructor(
    private readonly config: InternConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async startLogin(open = true): Promise<LoginInstructions> {
    this.requireOAuthConfig();
    const response = await this.fetchFn(
      `${this.config.archAstroBaseURL}/oauth/device/authorize`,
      {
        method: "POST",
        headers: this.oauthHeaders(),
        body: JSON.stringify({
          client: this.config.oauthClientID,
          scope: "profile",
        }),
      },
    );
    const body = await json(response);
    if (!response.ok)
      throw new Error(`authorization start failed: ${errorMessage(body)}`);
    const pending: PendingAuthorization = {
      deviceCode: requiredString(body, "device_code"),
      userCode: requiredString(body, "user_code"),
      verificationURI: requiredString(body, "verification_uri"),
      verificationURIComplete: requiredString(body, "verification_uri_complete"),
      expiresAt: Date.now() + requiredNumber(body, "expires_in") * 1000,
      intervalSeconds: Math.max(requiredNumber(body, "interval"), 1),
    };
    const existing = await this.read();
    await this.write({ version: 1, tokens: existing?.tokens, pending });
    if (open) openBrowser(pending.verificationURIComplete);
    return {
      userCode: pending.userCode,
      verificationURI: pending.verificationURI,
      verificationURIComplete: pending.verificationURIComplete,
      expiresAt: pending.expiresAt,
    };
  }

  async completeLogin(timeoutMs = 300_000): Promise<void> {
    this.requireOAuthConfig();
    const stored = await this.read();
    const pending = stored?.pending;
    if (!pending)
      throw new Error("no pending Intern authorization; call intern_login first");
    const deadline = Math.min(Date.now() + timeoutMs, pending.expiresAt);
    let interval = pending.intervalSeconds;
    while (Date.now() < deadline) {
      const response = await this.fetchFn(
        `${this.config.archAstroBaseURL}/oauth/token`,
        {
          method: "POST",
          headers: this.oauthHeaders(),
          body: JSON.stringify({
            grant_type: deviceGrant,
            device_code: pending.deviceCode,
            client: this.config.oauthClientID,
          }),
        },
      );
      const body = await json(response);
      if (response.ok) {
        await this.write({ version: 1, tokens: tokensFrom(body) });
        return;
      }
      const code = errorMessage(body);
      if (code === "slow_down") interval += 5;
      else if (code !== "authorization_pending")
        throw new Error(`authorization failed: ${code}`);
      await delay(interval * 1000);
    }
    throw new Error("authorization timed out; call intern_login to start again");
  }

  async accessToken(): Promise<string> {
    const envToken = process.env.INTERN_ACCESS_TOKEN;
    if (envToken) return envToken;
    const stored = await this.read();
    if (!stored?.tokens)
      throw new Error(
        "AUTH_REQUIRED: call intern_login, approve it, then call intern_complete_login",
      );
    if (!stored.tokens.expiresAt || stored.tokens.expiresAt > Date.now() + 60_000)
      return stored.tokens.accessToken;
    if (!stored.tokens.refreshToken)
      throw new Error("AUTH_REQUIRED: Intern session expired; sign in again");
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(stored.tokens.refreshToken).finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  async logout(): Promise<void> {
    await fs.rm(this.file(), { force: true });
  }

  async hasCredentials(): Promise<boolean> {
    return Boolean(process.env.INTERN_ACCESS_TOKEN || (await this.read())?.tokens);
  }

  private async refresh(refreshToken: string): Promise<string> {
    this.requireOAuthConfig(false);
    const response = await this.fetchFn(`${this.config.archAstroBaseURL}/oauth/token`, {
      method: "POST",
      headers: this.oauthHeaders(),
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const body = await json(response);
    if (!response.ok)
      throw new Error(`AUTH_REQUIRED: refresh failed: ${errorMessage(body)}`);
    const tokens = tokensFrom(body);
    await this.write({ version: 1, tokens });
    return tokens.accessToken;
  }

  private oauthHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-archastro-api-key": this.config.publishableKey!,
    };
  }

  private requireOAuthConfig(requireClient = true): void {
    if (!this.config.publishableKey || (requireClient && !this.config.oauthClientID)) {
      throw new Error(
        "Intern OAuth is not configured; provide the public app key and OAuth client ID",
      );
    }
  }

  private file(): string {
    return path.join(this.config.configRoot, "credentials.json");
  }

  private async read(): Promise<StoredAuth | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(), "utf8")) as StoredAuth;
    } catch {
      return null;
    }
  }

  private async write(value: StoredAuth): Promise<void> {
    await fs.mkdir(this.config.configRoot, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      this.config.configRoot,
      `.credentials.${process.pid}.${Date.now()}`,
    );
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(temporary, this.file());
    await fs.chmod(this.file(), 0o600);
  }
}

function tokensFrom(body: Record<string, unknown>): Tokens {
  return {
    accessToken: requiredString(body, "access_token"),
    refreshToken: optionalString(body, "refresh_token"),
    expiresAt: Date.now() + requiredNumber(body, "expires_in") * 1000,
    scope: optionalString(body, "scope"),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result)
    throw new Error(`OAuth response missing ${key}`);
  return result;
}
function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}
function requiredNumber(value: Record<string, unknown>, key: string): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isFinite(result))
    throw new Error(`OAuth response missing ${key}`);
  return result;
}
function errorMessage(value: Record<string, unknown>): string {
  return typeof value.error === "string" ? value.error : "request_failed";
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
