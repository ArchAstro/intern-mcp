import { describe, expect, it } from "vitest";
import { assertHttpUrl, AuthClient } from "./auth.js";

const config = {
  internBaseURL: "https://tryintern.dev",
  archAstroBaseURL: "https://platform.archastro.ai",
  publishableKey: "pk_test",
  oauthClientID: "cc_test",
  workspaceRoot: "/tmp/intern-auth-test/sites",
  configRoot: "/tmp/intern-auth-test/config",
};

describe("assertHttpUrl", () => {
  it("accepts HTTPS and loopback HTTP device pages", () => {
    expect(
      assertHttpUrl("https://tryintern.dev/device?code=ABCD", "verification URL"),
    ).toBe("https://tryintern.dev/device?code=ABCD");
    expect(assertHttpUrl("http://127.0.0.1:3100/device", "verification URL")).toBe(
      "http://127.0.0.1:3100/device",
    );
  });

  it("rejects non-HTTP schemes, credentials, and non-loopback HTTP", () => {
    expect(() => assertHttpUrl("javascript:alert(1)", "verification URL")).toThrow(
      "non-HTTP",
    );
    expect(() => assertHttpUrl("file:///etc/passwd", "verification URL")).toThrow(
      "non-HTTP",
    );
    expect(() =>
      assertHttpUrl("https://user:pass@tryintern.dev/device", "verification URL"),
    ).toThrow("embedded credentials");
    expect(() =>
      assertHttpUrl("http://evil.example/device", "verification URL"),
    ).toThrow("non-HTTPS");
  });
});

describe("AuthClient.startLogin", () => {
  it("refuses a device-approval URL that is not http(s)", async () => {
    const auth = new AuthClient(config, async () =>
      Response.json({
        device_code: "dc",
        user_code: "ABCD-EFGH",
        verification_uri: "javascript:alert(1)",
        verification_uri_complete: "javascript:alert(1)",
        expires_in: 600,
        interval: 1,
      }),
    );
    await expect(auth.startLogin(false)).rejects.toThrow("non-HTTP");
  });

  it("refuses verification URLs on different origins", async () => {
    const auth = new AuthClient(config, async () =>
      Response.json({
        device_code: "dc",
        user_code: "ABCD-EFGH",
        verification_uri: "https://tryintern.dev/device",
        verification_uri_complete: "https://evil.example/device?code=ABCD-EFGH",
        expires_in: 600,
        interval: 1,
      }),
    );
    await expect(auth.startLogin(false)).rejects.toThrow("different origins");
  });
});
