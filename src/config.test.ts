import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ARCHASTRO_API_URL,
  DEFAULT_ARCHASTRO_PUBLISHABLE_KEY,
  DEFAULT_INTERN_BASE_URL,
  DEFAULT_INTERN_OAUTH_CLIENT_ID,
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

  it("uses TryIntern production public values by default", () => {
    const config = loadConfig({ HOME: "/tmp/intern-config-test" });

    expect(config.internBaseURL).toBe(DEFAULT_INTERN_BASE_URL);
    expect(config.archAstroBaseURL).toBe(DEFAULT_ARCHASTRO_API_URL);
    expect(config.publishableKey).toBe(DEFAULT_ARCHASTRO_PUBLISHABLE_KEY);
    expect(config.oauthClientID).toBe(DEFAULT_INTERN_OAUTH_CLIENT_ID);
  });

  it("allows every public production value to be overridden for local testing", () => {
    const config = loadConfig({
      HOME: "/tmp/intern-config-test",
      INTERN_BASE_URL: "http://127.0.0.1:3100/",
      ARCHASTRO_API_URL: "http://127.0.0.1:4000/",
      ARCHASTRO_PUBLISHABLE_KEY: "pk_local",
      INTERN_OAUTH_CLIENT_ID: "cc_local",
    });

    expect(config).toMatchObject({
      internBaseURL: "http://127.0.0.1:3100",
      archAstroBaseURL: "http://127.0.0.1:4000",
      publishableKey: "pk_local",
      oauthClientID: "cc_local",
    });
  });
});
