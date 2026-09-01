import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
  InternAPI,
  isAcceptedProtectedFile,
  parseSiteRuntimeContract,
  previousProtectedV1Files,
  renderProtectedFile,
} from "./api.js";
import type { InternAPIError } from "./api.js";

test("preserves structured Intern API errors", async () => {
  const api = new InternAPI(
    {
      internBaseURL: "https://tryintern.dev",
      workspaceRoot: "/tmp/workspaces",
      configRoot: "/tmp/config",
    },
    { accessToken: async () => "candidate-token" } as never,
    async () => Response.json({ error: "org_not_ready" }, { status: 409 }),
  );

  await expect(api.createSite("docs")).rejects.toEqual(
    expect.objectContaining<Partial<InternAPIError>>({
      name: "InternAPIError",
      status: 409,
      code: "org_not_ready",
    }),
  );
});

const canonical = JSON.parse(
  await fs.readFile(
    fileURLToPath(new URL("../test/fixtures/runtime-contract.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;

const previousCanonical = JSON.parse(
  await fs.readFile(
    fileURLToPath(
      new URL("../test/fixtures/runtime-contract-previous.json", import.meta.url),
    ),
    "utf8",
  ),
) as Record<string, unknown>;

function requestTimeRootContract(): Record<string, unknown> {
  const contract = structuredClone(previousCanonical) as {
    protectedFiles: Record<string, string>;
  };
  const rootSelection =
    'const root=existsSync(join(cwd,"dist","index.html"))?join(cwd,"dist"):cwd; ';
  contract.protectedFiles["server.mjs"] = contract.protectedFiles["server.mjs"]
    .replace(rootSelection, "")
    .replace(
      "createServer(async (req,res)=>{try{",
      `createServer(async (req,res)=>{try{${rootSelection}`,
    );
  return contract;
}

function runtimeDigestContract(): Record<string, unknown> {
  const contract = requestTimeRootContract() as {
    protectedFiles: Record<string, string>;
  };
  contract.protectedFiles["server.mjs"] = contract.protectedFiles["server.mjs"]
    .replace(
      "const cwd=process.cwd(); ",
      'const cwd=process.cwd(); const runtimeDigest=process.env.INTERN_RUNTIME_DIGEST||""; ',
    )
    .replace(
      'res.writeHead(200,{"content-type":',
      'res.writeHead(200,{"x-intern-runtime-digest":runtimeDigest,"content-type":',
    )
    .replace(
      '}catch{res.writeHead(404);res.end("not found")}',
      '}catch{res.writeHead(404,{"x-intern-runtime-digest":runtimeDigest});res.end("not found")}',
    );
  return contract;
}

describe("Intern runtime contract parsing", () => {
  test("accepts the intern-data-owned v1 contract", () => {
    expect(parseSiteRuntimeContract(canonical)).toMatchObject({
      version: "intern-node-static-v1",
      entrypoint: "server.mjs",
    });
  });

  test("accepts every runtime contract during the runtime-digest rollout", () => {
    expect(parseSiteRuntimeContract(previousCanonical)).toMatchObject({
      version: "intern-node-static-v1",
    });
    expect(parseSiteRuntimeContract(requestTimeRootContract())).toMatchObject({
      version: "intern-node-static-v1",
    });
    expect(parseSiteRuntimeContract(runtimeDigestContract())).toMatchObject({
      version: "intern-node-static-v1",
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

  test("accepts every previous v1 server as a grandfathered checkout file", () => {
    const contract = parseSiteRuntimeContract(canonical);
    for (const previousTemplate of previousProtectedV1Files["server.mjs"]) {
      const previous = renderProtectedFile(previousTemplate, 4100);
      expect(isAcceptedProtectedFile("server.mjs", previous, contract, 4100)).toBe(
        true,
      );
    }
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

test("site plugins use generic GET, idempotent PUT, and DELETE installation resources", async () => {
  const requests: Request[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({
      installation: {
        binding: "PROFILE",
        plugin: "me",
        protocolVersion: 1,
        config: {},
        state: "active",
        errorCode: null,
      },
    });
  };
  const api = new InternAPI(
    {
      internBaseURL: "https://tryintern.dev",
      workspaceRoot: "/tmp/workspaces",
      configRoot: "/tmp/config",
    },
    { accessToken: async () => "archastro-token" } as never,
    fetchFn,
  );

  await expect(api.sitePlugins.get("docs site", "profile/me")).resolves.toEqual({
    binding: "PROFILE",
    plugin: "me",
    protocolVersion: 1,
    config: {},
    state: "active",
    errorCode: null,
  });
  await expect(api.sitePlugins.put("docs site", "profile/me", "me")).resolves.toEqual({
    binding: "PROFILE",
    plugin: "me",
    protocolVersion: 1,
    config: {},
    state: "active",
    errorCode: null,
  });
  await expect(api.sitePlugins.put("docs site", "profile/me", "me")).resolves.toEqual({
    binding: "PROFILE",
    plugin: "me",
    protocolVersion: 1,
    config: {},
    state: "active",
    errorCode: null,
  });
  await expect(
    api.sitePlugins.delete("docs site", "profile/me"),
  ).resolves.toBeUndefined();

  expect(
    requests.map((request) => ({ method: request.method, pathname: request.url })),
  ).toEqual([
    {
      method: "GET",
      pathname:
        "https://tryintern.dev/api/v1/mcp/sites/docs%20site/plugins/profile%2Fme",
    },
    {
      method: "PUT",
      pathname:
        "https://tryintern.dev/api/v1/mcp/sites/docs%20site/plugins/profile%2Fme",
    },
    {
      method: "PUT",
      pathname:
        "https://tryintern.dev/api/v1/mcp/sites/docs%20site/plugins/profile%2Fme",
    },
    {
      method: "DELETE",
      pathname:
        "https://tryintern.dev/api/v1/mcp/sites/docs%20site/plugins/profile%2Fme",
    },
  ]);
  await expect(requests[1]?.json()).resolves.toEqual({ plugin: "me", config: {} });
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

test("session verification forwards caller cancellation to the HTTP request", async () => {
  const controller = new AbortController();
  const fetchFn = vi.fn(
    async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      }),
  );
  const api = new InternAPI(
    {
      internBaseURL: "https://tryintern.dev",
      workspaceRoot: "/tmp/workspaces",
      configRoot: "/tmp/config",
    },
    { accessToken: async () => "candidate-token" } as never,
    fetchFn as typeof fetch,
  );

  const pending = api.session(controller.signal);
  await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
  controller.abort(new Error("setup interrupted by SIGINT"));

  await expect(pending).rejects.toThrow("setup interrupted by SIGINT");
}, 1_000);
