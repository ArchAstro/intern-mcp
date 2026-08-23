import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ARCHASTRO_API_URL,
  DEFAULT_ARCHASTRO_PUBLISHABLE_KEY,
  DEFAULT_INTERN_BASE_URL,
  DEFAULT_INTERN_OAUTH_CLIENT_ID,
  DEFAULT_INTERN_SDK_PACKAGE,
  loadConfig,
  PACKAGE_VERSION,
} from "./config.js";

describe("loadConfig", () => {
  it("uses the published package version for MCP server identity", () => {
    const packed = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    expect(PACKAGE_VERSION).toBe(packed.version);
  });

  it("uses the TryIntern production API by default", () => {
    const config = loadConfig({ HOME: "/tmp/intern-config-test" });

    expect(config.internBaseURL).toBe(DEFAULT_INTERN_BASE_URL);
    expect(config.archAstroBaseURL).toBe(DEFAULT_ARCHASTRO_API_URL);
    expect(config.publishableKey).toBe(DEFAULT_ARCHASTRO_PUBLISHABLE_KEY);
    expect(config.oauthClientID).toBe(DEFAULT_INTERN_OAUTH_CLIENT_ID);
    expect(config.internSDKPackage).toBe(DEFAULT_INTERN_SDK_PACKAGE);
    expect(DEFAULT_ARCHASTRO_API_URL).toBe("https://platform.archastro.ai");
    expect(DEFAULT_ARCHASTRO_PUBLISHABLE_KEY).toBe(
      "pk_dap_0344yXHSZ9tsm9NOpMQ6Y3_vGwdlFjMxYdiN0jtVN3wcsZ3krjKk_S4",
    );
    expect(DEFAULT_INTERN_OAUTH_CLIENT_ID).toBe("cc_vuMmqN4VbAKy8zsWRYorUg");
  });

  it("allows the Intern API to be overridden for local testing", () => {
    const config = loadConfig({
      HOME: "/tmp/intern-config-test",
      INTERN_BASE_URL: "http://127.0.0.1:3100/",
      ARCHASTRO_API_URL: "http://127.0.0.1:4000/",
      ARCHASTRO_PUBLISHABLE_KEY: "pk_local",
      INTERN_OAUTH_CLIENT_ID: "client_local",
      INTERN_SDK_PACKAGE: "file:/tmp/intern-sdk",
    });

    expect(config).toMatchObject({
      internBaseURL: "http://127.0.0.1:3100",
      archAstroBaseURL: "http://127.0.0.1:4000",
      publishableKey: "pk_local",
      oauthClientID: "client_local",
      internSDKPackage: "file:/tmp/intern-sdk",
    });
  });
});
