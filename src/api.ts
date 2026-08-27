import { createHash } from "node:crypto";
import type { AuthClient } from "./auth.js";
import type { InternConfig } from "./config.js";
import * as z from "zod/v4";

export type DiagnosticSink = (line: string) => void;

export interface InternSession {
  user: {
    id: string;
    org: string;
    org_name: string;
    org_role: "admin" | "member" | "viewer";
    email?: string | null;
    name?: string | null;
    profile_picture?: {
      url?: string | null;
      mime_type?: string | null;
      width?: number | null;
      height?: number | null;
    } | null;
  };
  org: {
    id: string | null;
    slug: string;
    state: string;
    nodeId?: string;
    wildcardDomain?: string;
  };
}

export class InternAPIError extends Error {
  readonly name = "InternAPIError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(
      status === 401
        ? `AUTH_REQUIRED: ${message}`
        : `Intern request failed: ${message}`,
    );
  }
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
  plugins?: SitePluginInstallation[];
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

export interface SitePluginInstallation {
  binding: string;
  plugin: string;
  protocolVersion: number;
  config: unknown;
  state: string;
  errorCode: string | null;
}

type APIRequest = <T>(pathname: string, init?: RequestInit) => Promise<T>;

/**
 * Generic client for the installation resource identified by a site and binding.
 * Resource existence means the plugin is installed; PUT is therefore idempotent.
 */
export class SitePluginsClient {
  constructor(private readonly request: APIRequest) {}

  async get(siteSlug: string, plugin: string): Promise<SitePluginInstallation> {
    const response = await this.request<{ installation: SitePluginInstallation }>(
      sitePluginPath(siteSlug, plugin),
    );
    return response.installation;
  }

  async list(siteSlug: string): Promise<SitePluginInstallation[]> {
    return (
      (await this.request<{ sites?: InternSite[] }>("/api/v1/mcp/sites")).sites?.find(
        (site) => site.slug === siteSlug,
      )?.plugins ?? []
    );
  }

  async put(
    siteSlug: string,
    binding: string,
    plugin: string,
    config: unknown = {},
  ): Promise<SitePluginInstallation> {
    const response = await this.request<{ installation: SitePluginInstallation }>(
      sitePluginPath(siteSlug, binding),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plugin, config }),
      },
    );
    return response.installation;
  }

  async delete(siteSlug: string, plugin: string): Promise<void> {
    await this.request(sitePluginPath(siteSlug, plugin), { method: "DELETE" });
  }
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

const protectedV1Hashes: Record<string, readonly string[]> = {
  "run-site.sh": ["3db0608bf5d67284d33302d78883eee91a849c69f5ece96f7c29a6c31c56bfbd"],
  "server.mjs": [
    "e62fd9f72d4358000f60e7addd3e132e6594a2846d3b2250f4f3bb8fc5335d0c",
    "d14f77f567f8fa167267f9a760b71046d50b9a2e6fa32829945003a7d42e7cea",
    "b23b6319c0963f560453d213d86c9e9fce9a159a243947bccf6c7e9517e5d2a1",
  ],
};

/** Earlier intern-node-static-v1 protected files that existing site commits may still contain. */
export const previousProtectedV1Files: Record<string, string[]> = {
  "server.mjs": [
    'import {createServer} from "node:http"; import {existsSync} from "node:fs"; import {readFile} from "node:fs/promises"; import {extname,join} from "node:path"; const cwd=process.cwd(); const port=Number(process.env.PORT || {{PORT}}); const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".map":"application/json",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".ico":"image/x-icon",".woff":"font/woff",".woff2":"font/woff2",".ttf":"font/ttf",".txt":"text/plain; charset=utf-8",".wasm":"application/wasm"}; createServer(async (req,res)=>{try{const root=existsSync(join(cwd,"dist","index.html"))?join(cwd,"dist"):cwd; const raw=(req.url||"/").split("?")[0]; const rel=raw==="/"?"index.html":raw.replace(/^\\/+/,""); if(rel.includes("..")) throw new Error("bad path"); let body; try{body=await readFile(join(root,rel))}catch{if(root===cwd) throw new Error("missing"); body=await readFile(join(cwd,rel))} res.writeHead(200,{"content-type":types[extname(rel)]||"application/octet-stream"}); res.end(body)}catch{res.writeHead(404);res.end("not found")}}).listen(Number(process.env.LISTEN_FDS)>0?{fd:3}:{port,host:"127.0.0.1"});\n',
    'import {createServer} from "node:http"; import {existsSync} from "node:fs"; import {readFile} from "node:fs/promises"; import {extname,join} from "node:path"; const cwd=process.cwd(); const root=existsSync(join(cwd,"dist","index.html"))?join(cwd,"dist"):cwd; const port=Number(process.env.PORT || {{PORT}}); const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".map":"application/json",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".ico":"image/x-icon",".woff":"font/woff",".woff2":"font/woff2",".ttf":"font/ttf",".txt":"text/plain; charset=utf-8",".wasm":"application/wasm"}; createServer(async (req,res)=>{try{const raw=(req.url||"/").split("?")[0]; const rel=raw==="/"?"index.html":raw.replace(/^\\/+/,""); if(rel.includes("..")) throw new Error("bad path"); let body; try{body=await readFile(join(root,rel))}catch{if(root===cwd) throw new Error("missing"); body=await readFile(join(cwd,rel))} res.writeHead(200,{"content-type":types[extname(rel)]||"application/octet-stream"}); res.end(body)}catch{res.writeHead(404);res.end("not found")}}).listen(Number(process.env.LISTEN_FDS)>0?{fd:3}:{port,host:"127.0.0.1"});\n',
    'import {createServer} from "node:http"; import {existsSync} from "node:fs"; import {readFile} from "node:fs/promises"; import {extname,join} from "node:path"; const cwd=process.cwd(); const root=existsSync(join(cwd,"dist","index.html"))?join(cwd,"dist"):cwd; const port=Number(process.env.PORT || {{PORT}}); const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".map":"application/json",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".ico":"image/x-icon",".woff":"font/woff",".woff2":"font/woff2",".ttf":"font/ttf",".txt":"text/plain; charset=utf-8",".wasm":"application/wasm"}; createServer(async (req,res)=>{try{const raw=(req.url||"/").split("?")[0]; const rel=raw==="/"?"index.html":raw.replace(/^\\/+/,""); if(rel.includes("..")) throw new Error("bad path"); let body; try{body=await readFile(join(root,rel))}catch{if(root===cwd) throw new Error("missing"); body=await readFile(join(cwd,rel))} res.writeHead(200,{"content-type":types[extname(rel)]||"application/octet-stream"}); res.end(body)}catch{res.writeHead(404);res.end("not found")}}).listen(port,"127.0.0.1");\n',
    'import {createServer} from "node:http"; import {readFile} from "node:fs/promises"; import {extname,join} from "node:path"; const root=process.cwd(); const port=Number(process.env.PORT || {{PORT}}); const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"}; createServer(async (req,res)=>{try{const raw=(req.url||"/").split("?")[0]; const rel=raw==="/"?"index.html":raw.replace(/^\\/+/,""); if(rel.includes("..")) throw new Error("bad path"); const body=await readFile(join(root,rel)); res.writeHead(200,{"content-type":types[extname(rel)]||"application/octet-stream"}); res.end(body)}catch{res.writeHead(404);res.end("not found")}}).listen(port,"127.0.0.1");\n',
  ],
};

export function renderProtectedFile(template: string, port: number): string {
  return template.replaceAll("{{PORT}}", String(port));
}

export function isAcceptedProtectedFile(
  name: string,
  actual: string,
  contract: SiteRuntimeContract,
  port: number,
): boolean {
  const expected = renderProtectedFile(contract.protectedFiles[name] ?? "", port);
  if (actual === expected) return true;
  return (previousProtectedV1Files[name] ?? []).some(
    (template) => renderProtectedFile(template, port) === actual,
  );
}

export function parseSiteRuntimeContract(value: unknown): SiteRuntimeContract {
  const contract = siteRuntimeContractSchema.parse(value);
  for (const [name, expected] of Object.entries(protectedV1Hashes)) {
    const actual = createHash("sha256")
      .update(contract.protectedFiles[name])
      .digest("hex");
    if (!expected.includes(actual))
      throw new Error(
        `Intern runtime contract v1 has unexpected protected content: ${name}`,
      );
  }
  return contract;
}

export class InternAPI {
  readonly sitePlugins: SitePluginsClient;

  constructor(
    private readonly config: InternConfig,
    private readonly auth: AuthClient,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly diagnostics?: DiagnosticSink,
  ) {
    this.sitePlugins = new SitePluginsClient((pathname, init) =>
      this.request(pathname, init),
    );
  }

  session(signal?: AbortSignal): Promise<InternSession> {
    return this.request("/api/v1/mcp/session", {}, signal);
  }

  async runtimeContract(): Promise<SiteRuntimeContract> {
    const response = await this.request<{ contract: unknown }>(
      "/api/v1/mcp/runtime-contract",
    );
    return parseSiteRuntimeContract(response.contract);
  }

  async listSites(signal?: AbortSignal): Promise<InternSite[]> {
    const response = await this.request<{ sites?: InternSite[] }>(
      "/api/v1/mcp/sites",
      {},
      signal,
    );
    return response.sites ?? [];
  }

  async createSite(
    slug: string,
    siteType = "vite",
    signal?: AbortSignal,
  ): Promise<InternSite> {
    const response = await this.request<{ site: InternSite }>(
      "/api/v1/mcp/sites",
      {
        method: "POST",
        body: JSON.stringify({ slug, siteType }),
      },
      signal,
    );
    return response.site;
  }

  async mintSSHCertificate(publicKey: string): Promise<SSHCredential> {
    return this.request("/api/v1/mcp/ssh-certificate", {
      method: "POST",
      body: JSON.stringify({ publicKey }),
    });
  }

  private async request<T>(
    pathname: string,
    init: RequestInit = {},
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const signal = combinedSignal(init.signal, callerSignal);
    const token = await this.auth.accessToken(signal);
    const method = init.method ?? "GET";
    const diagnosticFields = {
      method,
      origin: diagnosticOrigin(this.config.internBaseURL),
      path: pathname,
    };
    const startedAt = performance.now();
    this.log("http.start", diagnosticFields);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.internBaseURL}${pathname}`, {
        ...init,
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...(this.config.iapIDToken
            ? { "proxy-authorization": `Bearer ${this.config.iapIDToken}` }
            : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      this.log("http.error", {
        ...diagnosticFields,
        durationMs: Math.round(performance.now() - startedAt),
        errorName: safeErrorName(error),
        ...safeErrorCodes(error),
      });
      throw error;
    }
    this.log("http.response", {
      ...diagnosticFields,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      ...diagnosticResponseHeaders(response),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message =
        typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new InternAPIError(response.status, message, message);
    }
    return body as T;
  }

  private log(event: string, fields: Record<string, string | number | boolean>): void {
    if (!this.diagnostics) return;
    const values = Object.entries(fields)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join(" ");
    this.diagnostics(`[intern-mcp] ${event} ${values}`);
  }
}

function combinedSignal(
  requestSignal?: AbortSignal | null,
  callerSignal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  const signals = [requestSignal, callerSignal, timeout].filter(
    (signal): signal is AbortSignal => signal !== undefined && signal !== null,
  );
  return signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
}

function sitePluginPath(siteSlug: string, plugin: string): string {
  return `/api/v1/mcp/sites/${encodeURIComponent(siteSlug)}/plugins/${encodeURIComponent(plugin)}`;
}

function diagnosticOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "invalid-url";
  }
}

function diagnosticResponseHeaders(
  response: Response,
): Record<string, string | boolean> {
  const fields: Record<string, string | boolean> = {};
  const contentType = response.headers.get("content-type");
  if (
    contentType &&
    /^[A-Za-z0-9!#$&^_.+/-]+(?:;\s*[A-Za-z0-9!#$&^_.+/-]+=[A-Za-z0-9!#$&^_.+/-]+)*$/.test(
      contentType,
    )
  ) {
    fields.contentType = contentType;
  }
  const requestID = response.headers.get("x-request-id");
  if (requestID && /^[A-Za-z0-9._:-]{1,128}$/.test(requestID)) {
    fields.requestId = requestID;
  }
  if (response.headers.get("x-goog-iap-generated-response") === "true") {
    fields.iapGeneratedResponse = true;
  }
  return fields;
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "Error";
}

function safeErrorCodes(error: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  const code = errorCode(error);
  if (code) fields.errorCode = code;
  const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
  const causeCode = errorCode(cause);
  if (causeCode) fields.causeCode = causeCode;
  return fields;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const value = String(error.code);
  return /^[A-Z0-9_]{1,40}$/.test(value) ? value : undefined;
}
