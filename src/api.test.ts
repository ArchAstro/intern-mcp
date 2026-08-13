import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { InternAPI, parseSiteRuntimeContract } from "./api.js";

const canonical = JSON.parse(
  await fs.readFile(
    fileURLToPath(new URL("../test/fixtures/runtime-contract.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;

describe("Intern runtime contract parsing", () => {
  test("accepts the intern-data-owned v1 contract", () => {
    expect(parseSiteRuntimeContract(canonical)).toMatchObject({
      version: "intern-node-static-v1",
      entrypoint: "server.mjs",
    });
  });

  test("rejects a v1 contract that relabels model-authored server code as protected", () => {
    const altered = structuredClone(canonical) as {
      protectedFiles: Record<string, string>;
    };
    altered.protectedFiles["server.mjs"] = 'console.log("not the v1 runtime")\n';
    expect(() => parseSiteRuntimeContract(altered)).toThrow(
      "unexpected protected content",
    );
  });

  test("rejects missing protected files and changed required-file semantics", () => {
    const missing = structuredClone(canonical) as {
      protectedFiles: Record<string, string>;
    };
    delete missing.protectedFiles["server.mjs"];
    expect(() => parseSiteRuntimeContract(missing)).toThrow();

    const changed = structuredClone(canonical) as { requiredFiles: string[] };
    changed.requiredFiles = ["package.json", "index.html", "run-site.sh"];
    expect(() => parseSiteRuntimeContract(changed)).toThrow();
  });
});

test("sends IAP and ArchAstro credentials in separate headers when minting SSH certificates", async () => {
  let request: Request | undefined;
  const fetchFn: typeof fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({
      certificate: "cert",
      hostPublicKey: "host",
      username: "stripe",
      expiresAt: 123,
    });
  };
  const api = new InternAPI(
    {
      internBaseURL: "https://tryintern.dev",
      archAstroBaseURL: "https://api.archastro.ai",
      workspaceRoot: "/tmp/workspaces",
      configRoot: "/tmp/config",
      iapIDToken: "google-id-token",
    },
    { accessToken: async () => "archastro-token" } as never,
    fetchFn,
  );
  await api.mintSSHCertificate("ssh-ed25519 AAAA");
  expect(request?.headers.get("proxy-authorization")).toBe("Bearer google-id-token");
  expect(request?.headers.get("authorization")).toBe("Bearer archastro-token");
});
