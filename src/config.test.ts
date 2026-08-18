import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_INTERN_BASE_URL, loadConfig, PACKAGE_VERSION } from "./config.js";

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
  });

  it("allows the Intern API to be overridden for local testing", () => {
    const config = loadConfig({
      HOME: "/tmp/intern-config-test",
      INTERN_BASE_URL: "http://127.0.0.1:3100/",
    });

    expect(config).toMatchObject({
      internBaseURL: "http://127.0.0.1:3100",
    });
  });
});
