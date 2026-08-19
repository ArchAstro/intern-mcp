import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  InternAPI,
  isAcceptedProtectedFile,
  parseSiteRuntimeContract,
  previousProtectedV1Files,
  renderProtectedFile,
} from "./api.js";

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

  test("accepts the previous v1 server as a grandfathered checkout file", () => {
    const contract = parseSiteRuntimeContract(canonical);
    const previous = renderProtectedFile(
      previousProtectedV1Files["server.mjs"][0],
      4100,
    );
    expect(isAcceptedProtectedFile("server.mjs", previous, contract, 4100)).toBe(true);
    expect(
      isAcceptedProtectedFile(
        "server.mjs",
        'console.log("not the v1 runtime")\n',
        contract,
        4100,
      ),
    ).toBe(false);
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

test("verbose diagnostics identify an IAP interception without exposing request secrets", async () => {
  const diagnostics: string[] = [];
  const api = new InternAPI(
    {
      internBaseURL: "https://tryintern.dev",
      workspaceRoot: "/tmp/workspaces",
      configRoot: "/tmp/config",
    },
    { accessToken: async () => "secret-profile-token" } as never,
    async () =>
      new Response("Invalid IAP credentials: secret-reflection", {
        status: 401,
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "set-cookie": "session=secret-cookie",
          "x-goog-iap-generated-response": "true",
          "x-private-header": "secret-header",
        },
      }),
    (line) => diagnostics.push(line),
  );

  await expect(api.session()).rejects.toThrow("AUTH_REQUIRED");
  const output = diagnostics.join("\n");
  expect(output).toContain("http.response");
  expect(output).toContain("status=401");
  expect(output).toContain("iapGeneratedResponse=true");
  expect(output).not.toContain("secret-profile-token");
  expect(output).not.toContain("secret-reflection");
  expect(output).not.toContain("secret-cookie");
  expect(output).not.toContain("secret-header");
});
