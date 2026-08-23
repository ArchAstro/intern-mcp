import { spawn } from "node:child_process";

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceAuthorizationConfig {
  platformBaseURL: string;
  publishableKey: string;
  oauthClientID: string;
}

export interface PendingDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationURI: string;
  verificationURIComplete: string;
  expiresAtMs: number;
  intervalMs: number;
}

export interface OAuthCandidate {
  platformBaseURL: string;
  oauthClientID: string;
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  scope: string;
}

interface DeviceAuthorizationDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  openBrowser?: (url: string) => Promise<void>;
  write?: (message: string) => void;
  requestTimeoutMs?: number;
}

export class DeviceAuthorization {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: ((milliseconds: number) => Promise<void>) | undefined;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly write: (message: string) => void;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly config: DeviceAuthorizationConfig,
    dependencies: DeviceAuthorizationDependencies = {},
  ) {
    this.fetchFn = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep;
    this.openBrowser = dependencies.openBrowser ?? openBrowser;
    this.write = dependencies.write ?? ((message) => process.stderr.write(message));
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? 30_000;
  }

  async start(open = true, signal?: AbortSignal): Promise<PendingDeviceAuthorization> {
    signal?.throwIfAborted();
    const response = await this.post(
      "/oauth/device/authorize",
      {
        client: this.config.oauthClientID,
        scope: "profile",
      },
      signal,
    );
    const body = await responseBody(response);
    if (!response.ok) {
      throw new Error(`authorization start failed: ${errorCode(body)}`);
    }
    const deviceCode = requiredString(body, "device_code");
    const userCode = requiredString(body, "user_code");
    const verificationURI = requiredString(body, "verification_uri");
    const verificationURIComplete = requiredString(body, "verification_uri_complete");
    const expiresIn = requiredNumber(body, "expires_in");
    const interval = requiredNumber(body, "interval");
    const urls = validatedVerificationURLs(
      verificationURI,
      verificationURIComplete,
      userCode,
      allowsLoopbackHTTP(this.config.platformBaseURL),
    );
    const authorization: PendingDeviceAuthorization = {
      deviceCode,
      userCode,
      verificationURI: urls.base,
      verificationURIComplete: urls.complete,
      expiresAtMs: this.now() + expiresIn * 1_000,
      intervalMs: Math.max(interval, 1) * 1_000,
    };
    this.write(
      `Open ${authorization.verificationURIComplete}\nCode: ${authorization.userCode}\n`,
    );
    signal?.throwIfAborted();
    if (open)
      await Promise.resolve(
        this.openBrowser(authorization.verificationURIComplete),
      ).catch(() => {});
    signal?.throwIfAborted();
    return authorization;
  }

  async poll(
    authorization: PendingDeviceAuthorization,
    timeoutMs = 300_000,
    signal?: AbortSignal,
  ): Promise<OAuthCandidate> {
    const timeoutDeadline = this.now() + Math.max(timeoutMs, 0);
    const deadline = Math.min(timeoutDeadline, authorization.expiresAtMs);
    let intervalMs = authorization.intervalMs;
    while (this.now() < deadline) {
      signal?.throwIfAborted();
      const response = await this.post(
        "/oauth/token",
        {
          grant_type: deviceGrant,
          device_code: authorization.deviceCode,
          client: this.config.oauthClientID,
        },
        signal,
      );
      const body = await responseBody(response);
      if (response.ok) return this.candidate(body);
      const code = errorCode(body);
      if (code === "access_denied") throw new Error("authorization denied");
      if (code === "expired_token") throw new Error("authorization expired");
      if (code === "slow_down") intervalMs += 5_000;
      else if (code !== "authorization_pending") {
        throw new Error(`authorization failed: ${code}`);
      }
      const waitMs = Math.min(intervalMs, deadline - this.now());
      await (this.sleep
        ? waitForInjectedSleep(this.sleep, waitMs, signal)
        : delay(waitMs, signal));
    }
    if (
      authorization.expiresAtMs <= timeoutDeadline &&
      this.now() >= authorization.expiresAtMs
    ) {
      throw new Error("authorization expired; run setup again");
    }
    throw new Error("authorization timed out; run setup again");
  }

  async authorize(timeoutMs = 300_000, signal?: AbortSignal): Promise<OAuthCandidate> {
    return this.poll(await this.start(true, signal), timeoutMs, signal);
  }

  async refresh(
    refreshToken: string,
    callerSignal?: AbortSignal,
  ): Promise<OAuthCandidate> {
    const deadline = requestDeadline(this.requestTimeoutMs, callerSignal);
    try {
      const response = await this.post(
        "/oauth/token",
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
        deadline.signal,
      );
      const body = await responseBody(response);
      if (!response.ok) throw new Error(`refresh failed: ${errorCode(body)}`);
      return this.candidate(body);
    } catch (error) {
      if (deadline.timedOut()) {
        throw new Error(`refresh request timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      deadline.dispose();
    }
  }

  private candidate(body: Record<string, unknown>): OAuthCandidate {
    return {
      platformBaseURL: this.config.platformBaseURL,
      oauthClientID: this.config.oauthClientID,
      accessToken: requiredString(body, "access_token"),
      refreshToken: requiredString(body, "refresh_token"),
      expiresAtMs: this.now() + requiredNumber(body, "expires_in") * 1_000,
      scope: requiredString(body, "scope"),
    };
  }

  private post(
    pathname: string,
    body: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.fetchFn(`${this.config.platformBaseURL}${pathname}`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-archastro-api-key": this.config.publishableKey,
      },
      body: JSON.stringify(body),
    });
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

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OAuth response missing ${field}`);
  }
  return value;
}

function requiredNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`OAuth response missing ${field}`);
  }
  return value;
}

function errorCode(body: Record<string, unknown>): string {
  return typeof body.error === "string" && body.error ? body.error : "request_failed";
}

function validatedVerificationURLs(
  baseValue: string,
  completeValue: string,
  userCode: string,
  allowLoopbackHTTP: boolean,
): { base: string; complete: string } {
  if (!/^[A-Za-z0-9-]{4,32}$/.test(userCode)) {
    throw new Error("OAuth response has an unsafe verification code");
  }
  if (hasControlCharacter(baseValue) || hasControlCharacter(completeValue)) {
    throw new Error("OAuth response has an unsafe verification URL");
  }
  let base: URL;
  let complete: URL;
  try {
    base = new URL(baseValue);
    complete = new URL(completeValue);
  } catch {
    throw new Error("OAuth response has a malformed verification URL");
  }
  validateBrowserURL(base, allowLoopbackHTTP);
  validateBrowserURL(complete, allowLoopbackHTTP);
  if (base.search || base.hash || complete.hash) {
    throw new Error("OAuth response has an unsafe verification URL");
  }
  if (base.origin !== complete.origin || base.pathname !== complete.pathname) {
    throw new Error("OAuth verification URLs do not match");
  }
  const parameters = [...complete.searchParams.entries()];
  if (
    parameters.length !== 1 ||
    parameters[0]?.[0] !== "code" ||
    parameters[0]?.[1] !== userCode
  ) {
    throw new Error("OAuth verification URL does not contain the expected code");
  }
  return { base: base.toString(), complete: complete.toString() };
}

function validateBrowserURL(url: URL, allowLoopbackHTTP: boolean): void {
  if (url.username || url.password) {
    throw new Error("OAuth verification URL must not contain credentials");
  }
  if (url.protocol === "https:") return;
  const hostname = url.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1";
  if (url.protocol !== "http:" || !loopback || !allowLoopbackHTTP) {
    throw new Error("OAuth verification URL must use HTTPS or loopback HTTP");
  }
}

function allowsLoopbackHTTP(platformBaseURL: string): boolean {
  try {
    const url = new URL(platformBaseURL);
    if (url.protocol !== "http:" || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function requestDeadline(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let didTimeOut = false;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted) onCallerAbort();
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
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

function openBrowser(url: string): Promise<void> {
  const { command, args } = browserLaunch(process.platform, url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function browserLaunch(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  return { command: "xdg-open", args: [url] };
}
