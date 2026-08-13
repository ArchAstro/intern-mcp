import { createHash } from "node:crypto";
import type { AuthClient } from "./auth.js";
import type { InternConfig } from "./config.js";
import * as z from "zod/v4";

export interface InternSession {
  user: {
    id: string;
    org: string;
    org_name: string;
    org_role: "admin" | "member" | "viewer";
  };
  org: {
    id: string;
    slug: string;
    state: string;
    nodeId?: string;
    wildcardDomain?: string;
  };
}

export interface InternSite {
  id: string;
  orgSlug: string;
  slug: string;
  state: string;
  siteType: string;
  port: number;
  url: string;
  gitUrl: string;
}

export interface SiteRuntimeContract {
  version: string;
  siteTypes: string[];
  runtime: "node";
  entrypoint: string;
  launchCommand: string[];
  requiredFiles: string[];
  protectedFiles: Record<string, string>;
  packageInstall: false;
  portEnvironmentVariable: "PORT";
  listenHost: "127.0.0.1";
  startupTimeoutMs: number;
}

export interface SSHCredential {
  certificate: string;
  hostPublicKey: string;
  username: string;
  expiresAt: number;
}

const siteRuntimeContractSchema: z.ZodType<SiteRuntimeContract> = z
  .object({
    version: z.literal("intern-node-static-v1"),
    siteTypes: z.array(z.string().min(1).max(50)).min(1).max(20),
    runtime: z.literal("node"),
    entrypoint: z.literal("server.mjs"),
    launchCommand: z.tuple([z.literal("node"), z.literal("server.mjs")]),
    requiredFiles: z.tuple([
      z.literal("package.json"),
      z.literal("index.html"),
      z.literal("server.mjs"),
      z.literal("run-site.sh"),
    ]),
    protectedFiles: z
      .object({
        "run-site.sh": z.string().max(128 * 1024),
        "server.mjs": z.string().max(128 * 1024),
      })
      .strict(),
    packageInstall: z.literal(false),
    portEnvironmentVariable: z.literal("PORT"),
    listenHost: z.literal("127.0.0.1"),
    startupTimeoutMs: z.literal(5_000),
  })
  .strict();

const protectedV1Hashes: Record<string, string> = {
  "run-site.sh": "3db0608bf5d67284d33302d78883eee91a849c69f5ece96f7c29a6c31c56bfbd",
  "server.mjs": "93080da2f54e8e8d28feb6f6039edf0b9a959b1b4c446d51a6fe1e18b38a783c",
};

export function parseSiteRuntimeContract(value: unknown): SiteRuntimeContract {
  const contract = siteRuntimeContractSchema.parse(value);
  for (const [name, expected] of Object.entries(protectedV1Hashes)) {
    const actual = createHash("sha256")
      .update(contract.protectedFiles[name])
      .digest("hex");
    if (actual !== expected)
      throw new Error(
        `Intern runtime contract v1 has unexpected protected content: ${name}`,
      );
  }
  return contract;
}

export class InternAPI {
  constructor(
    private readonly config: InternConfig,
    private readonly auth: AuthClient,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  session(): Promise<InternSession> {
    return this.request("/api/v1/mcp/session");
  }

  async runtimeContract(): Promise<SiteRuntimeContract> {
    const response = await this.request<{ contract: unknown }>(
      "/api/v1/mcp/runtime-contract",
    );
    return parseSiteRuntimeContract(response.contract);
  }

  async listSites(): Promise<InternSite[]> {
    const response = await this.request<{ sites?: InternSite[] }>("/api/v1/mcp/sites");
    return response.sites ?? [];
  }

  async createSite(slug: string, siteType = "vite"): Promise<InternSite> {
    const response = await this.request<{ site: InternSite }>("/api/v1/mcp/sites", {
      method: "POST",
      body: JSON.stringify({ slug, siteType }),
    });
    return response.site;
  }

  async mintSSHCertificate(publicKey: string): Promise<SSHCredential> {
    return this.request("/api/v1/mcp/ssh-certificate", {
      method: "POST",
      body: JSON.stringify({ publicKey }),
    });
  }

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const token = await this.auth.accessToken();
    const response = await this.fetchFn(`${this.config.internBaseURL}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(this.config.iapIDToken
          ? { "proxy-authorization": `Bearer ${this.config.iapIDToken}` }
          : {}),
        ...init.headers,
      },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message =
        typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new Error(
        response.status === 401
          ? `AUTH_REQUIRED: ${message}`
          : `Intern request failed: ${message}`,
      );
    }
    return body as T;
  }
}
