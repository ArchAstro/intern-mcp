import { describe, expect, it } from "vitest";
import { AuthClient } from "./auth.js";

describe("AuthClient", () => {
  it("returns the access token supplied by the MCP host", async () => {
    const auth = new AuthClient("  atk_intern_test  ");

    await expect(auth.hasCredentials()).resolves.toBe(true);
    await expect(auth.accessToken()).resolves.toBe("atk_intern_test");
  });

  it("gives an actionable setup error without accepting credentials in-band", async () => {
    const auth = new AuthClient(" ");

    await expect(auth.hasCredentials()).resolves.toBe(false);
    await expect(auth.accessToken()).rejects.toThrow(
      "create a profile access token at https://tryintern.dev/connect",
    );
  });
});
