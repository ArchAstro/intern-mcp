import { describe, expect, it, vi } from "vitest";
import {
  browserLaunch,
  DeviceAuthorization,
  type PendingDeviceAuthorization,
} from "./device-authorization.js";

const config = {
  platformBaseURL: "https://platform.example",
  publishableKey: "pk_public",
  oauthClientID: "client_intern",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pending(overrides: Partial<PendingDeviceAuthorization> = {}) {
  return {
    deviceCode: "device-secret",
    userCode: "ABC-123",
    verificationURI: "https://tryintern.dev/device",
    verificationURIComplete: "https://tryintern.dev/device?code=ABC-123",
    expiresAtMs: 120_000,
    intervalMs: 5_000,
    ...overrides,
  };
}

describe("DeviceAuthorization", () => {
  it("uses an argument-safe native Windows URL opener without cmd.exe", () => {
    expect(browserLaunch("win32", "https://tryintern.dev/device?code=ABC-123")).toEqual(
      {
        command: "rundll32.exe",
        args: [
          "url.dll,FileProtocolHandler",
          "https://tryintern.dev/device?code=ABC-123",
        ],
      },
    );
  });
  it("starts a device authorization with the public Platform contract", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const auth = new DeviceAuthorization(config, {
      now: () => 10_000,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return response({
          device_code: "device-secret",
          user_code: "ABC-123",
          verification_uri: "https://tryintern.dev/device",
          verification_uri_complete: "https://tryintern.dev/device?code=ABC-123",
          expires_in: 600,
          interval: 5,
        });
      },
      openBrowser: async () => {},
      write: () => {},
    });

    await expect(auth.start()).resolves.toEqual({
      ...pending(),
      expiresAtMs: 610_000,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://platform.example/oauth/device/authorize");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-archastro-api-key": "pk_public",
      },
      body: JSON.stringify({ client: "client_intern", scope: "profile" }),
    });
  });

  it("prints the complete URL and short code even when opening the browser fails", async () => {
    const written: string[] = [];
    const auth = new DeviceAuthorization(config, {
      now: () => 0,
      fetch: async () =>
        response({
          device_code: "device-secret",
          user_code: "ABC-123",
          verification_uri: "https://tryintern.dev/device",
          verification_uri_complete: "https://tryintern.dev/device?code=ABC-123",
          expires_in: 120,
          interval: 5,
        }),
      openBrowser: async () => {
        throw new Error("no browser");
      },
      write: (message) => written.push(message),
    });

    await expect(auth.start()).resolves.toMatchObject({
      userCode: "ABC-123",
      verificationURIComplete: "https://tryintern.dev/device?code=ABC-123",
    });
    expect(written.join("\n")).toContain("https://tryintern.dev/device?code=ABC-123");
    expect(written.join("\n")).toContain("ABC-123");
  });

  it.each([
    ["javascript:alert(1)", "javascript:alert(1)"],
    ["file:///tmp/device", "file:///tmp/device?code=ABC-123"],
    ["http://evil.example/device", "http://evil.example/device?code=ABC-123"],
    ["http://localhost:3100/device", "http://localhost:3100/device?code=ABC-123"],
    [
      "https://user:password@tryintern.dev/device",
      "https://user:password@tryintern.dev/device?code=ABC-123",
    ],
    ["not a URL", "not a URL?code=ABC-123"],
    ["https://tryintern.dev/device", "https://evil.example/device?code=ABC-123"],
    ["https://tryintern.dev/device", "https://tryintern.dev/other?code=ABC-123"],
    [
      "https://tryintern.dev/device",
      "https://tryintern.dev/device?code=ABC-123%26calc.exe",
    ],
  ])("rejects unsafe device browser URLs: %s", async (verificationURI, complete) => {
    const openBrowser = vi.fn();
    const auth = new DeviceAuthorization(config, {
      fetch: async () =>
        response({
          device_code: "device-secret",
          user_code: "ABC-123",
          verification_uri: verificationURI,
          verification_uri_complete: complete,
          expires_in: 120,
          interval: 5,
        }),
      openBrowser,
      write: () => {},
    });

    await expect(auth.start()).rejects.toThrow(/verification|URL|code/i);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it.each([
    ["https://tryintern.dev/device", "https://tryintern.dev/device?code=ABC-123"],
    ["http://127.0.0.1:3100/device", "http://127.0.0.1:3100/device?code=ABC-123"],
    ["http://localhost:3100/device", "http://localhost:3100/device?code=ABC-123"],
    ["http://[::1]:3100/device", "http://[::1]:3100/device?code=ABC-123"],
  ])(
    "accepts a safe production or loopback browser URL: %s",
    async (base, complete) => {
      const openBrowser = vi.fn(async () => {});
      const auth = new DeviceAuthorization(
        {
          ...config,
          platformBaseURL: base.startsWith("http:")
            ? new URL(base).origin
            : config.platformBaseURL,
        },
        {
          fetch: async () =>
            response({
              device_code: "device-secret",
              user_code: "ABC-123",
              verification_uri: base,
              verification_uri_complete: complete,
              expires_in: 120,
              interval: 5,
            }),
          openBrowser,
          write: () => {},
        },
      );

      await expect(auth.start()).resolves.toMatchObject({
        verificationURI: base,
        verificationURIComplete: complete,
      });
      expect(openBrowser).toHaveBeenCalledWith(complete);
    },
  );

  it("polls through pending and slow_down before returning approved tokens", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const requests: Array<{ url: string; body: unknown }> = [];
    const replies = [
      response({ error: "authorization_pending" }, 400),
      response({ error: "slow_down" }, 400),
      response({
        access_token: "access-one",
        refresh_token: "refresh-one",
        expires_in: 3600,
        scope: "profile",
      }),
    ];
    const auth = new DeviceAuthorization(config, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return replies.shift()!;
      },
    });

    await expect(auth.poll(pending())).resolves.toEqual({
      platformBaseURL: "https://platform.example",
      oauthClientID: "client_intern",
      accessToken: "access-one",
      refreshToken: "refresh-one",
      expiresAtMs: 3_615_000,
      scope: "profile",
    });
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(requests).toEqual([
      {
        url: "https://platform.example/oauth/token",
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "device-secret",
          client: "client_intern",
        },
      },
      {
        url: "https://platform.example/oauth/token",
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "device-secret",
          client: "client_intern",
        },
      },
      {
        url: "https://platform.example/oauth/token",
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "device-secret",
          client: "client_intern",
        },
      },
    ]);
  });

  it("fails directly when authorization is denied", async () => {
    const auth = new DeviceAuthorization(config, {
      now: () => 0,
      fetch: async () => response({ error: "access_denied" }, 400),
    });
    await expect(auth.poll(pending())).rejects.toThrow("authorization denied");
  });

  it("fails directly when authorization expires", async () => {
    const auth = new DeviceAuthorization(config, {
      now: () => 0,
      fetch: async () => response({ error: "expired_token" }, 400),
    });
    await expect(auth.poll(pending())).rejects.toThrow("authorization expired");
  });

  it("times out without busy-looping", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const fetchFn = vi.fn(async () =>
      response({ error: "authorization_pending" }, 400),
    );
    const auth = new DeviceAuthorization(config, {
      now: () => now,
      sleep,
      fetch: fetchFn,
    });

    await expect(auth.poll(pending(), 9_000)).rejects.toThrow(
      "authorization timed out",
    );
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("aborts a pending authorization without waiting for the next poll", async () => {
    const controller = new AbortController();
    const sleep = vi.fn(() => new Promise<void>(() => {}));
    const auth = new DeviceAuthorization(config, {
      now: () => 0,
      sleep,
      fetch: async () => response({ error: "authorization_pending" }, 400),
    });

    const polling = auth.poll(pending(), 30_000, controller.signal);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
    controller.abort(new Error("setup interrupted by SIGINT"));

    await expect(polling).rejects.toThrow("setup interrupted by SIGINT");
  });

  it("reports local device-code expiry when its deadline arrives while pending", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const auth = new DeviceAuthorization(config, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      fetch: async () => response({ error: "authorization_pending" }, 400),
    });

    await expect(auth.poll(pending({ expiresAtMs: 9_000 }), 30_000)).rejects.toThrow(
      "authorization expired",
    );
    expect(sleeps).toEqual([5_000, 4_000]);
  });

  it.each([
    [{ user_code: "ABC" }, "device_code"],
    [{ device_code: "device", user_code: "ABC" }, "verification_uri"],
    [
      {
        device_code: "device",
        user_code: "ABC",
        verification_uri: "https://tryintern.dev/device",
        verification_uri_complete: "https://tryintern.dev/device?code=ABC",
        expires_in: "600",
        interval: 5,
      },
      "expires_in",
    ],
  ])("rejects a malformed device response missing %s", async (body, field) => {
    const auth = new DeviceAuthorization(config, {
      fetch: async () => response(body),
      openBrowser: async () => {},
      write: () => {},
    });
    await expect(auth.start()).rejects.toThrow(`missing ${field}`);
  });

  it("exchanges a refresh token and accepts a rotated refresh token", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const auth = new DeviceAuthorization(config, {
      now: () => 50_000,
      fetch: async (url, init) => {
        request = { url: String(url), init };
        return response({
          access_token: "access-two",
          refresh_token: "refresh-two",
          expires_in: 7200,
          scope: "profile",
        });
      },
    });

    await expect(auth.refresh("refresh-one")).resolves.toEqual({
      platformBaseURL: "https://platform.example",
      oauthClientID: "client_intern",
      accessToken: "access-two",
      refreshToken: "refresh-two",
      expiresAtMs: 7_250_000,
      scope: "profile",
    });
    expect(request).toEqual({
      url: "https://platform.example/oauth/token",
      init: {
        method: "POST",
        signal: expect.any(AbortSignal),
        headers: {
          "content-type": "application/json",
          "x-archastro-api-key": "pk_public",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "refresh-one",
        }),
      },
    });
  });

  it("rejects malformed refresh responses", async () => {
    const auth = new DeviceAuthorization(config, {
      fetch: async () => response({ refresh_token: "rotated", expires_in: 3600 }),
    });
    await expect(auth.refresh("refresh-one")).rejects.toThrow("missing access_token");
  });

  it("bounds a refresh request and reports a meaningful timeout", async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const auth = new DeviceAuthorization(config, {
      fetch: fetchFn as typeof fetch,
      requestTimeoutMs: 20,
    });

    await expect(auth.refresh("refresh-token")).rejects.toThrow(
      "refresh request timed out",
    );
  });
});
