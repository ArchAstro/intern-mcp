import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type {
  CurrentUser,
  MeUpdate,
  ProfilePictureUpload,
} from "@archastro/intern-sdk";
import { INTERN_PROTOCOL_VERSION } from "@archastro/intern-sdk/runtime";
import { MemoryMeImplementation } from "@archastro/intern-sdk/testing";
import type { InternSession, SiteRuntimeContract } from "./api.js";
import { startSiteRuntime, type RunningSiteRuntime } from "./validation.js";

const runtimeScriptPath = "/.intern/runtime.js";
const meAPIPath = "/.intern/api/me";
const runtimeTag = `<script src="${runtimeScriptPath}"></script>`;
const maxHTMLBytes = 4 * 1024 * 1024;
const maxUpdateBytes = 12 * 1024 * 1024;
const maxPictureBytes = 8 * 1024 * 1024;

interface DecodedMeUpdate {
  name?: string | null;
  profilePicture?: ProfilePictureUpload | null;
}

export function localUserFromSession(session: InternSession): CurrentUser {
  const picture = session.user.profile_picture;
  return {
    id: session.user.id,
    email: session.user.email ?? null,
    name: session.user.name ?? null,
    profilePicture: picture?.url
      ? {
          url: picture.url,
          contentType: picture.mime_type ?? null,
          width: picture.width ?? null,
          height: picture.height ?? null,
        }
      : null,
    viewer: {
      userId: session.user.id,
      appId: null,
      orgId: session.user.org,
      orgName: session.user.org_name,
      orgSlug: session.org.slug,
      orgRole: session.user.org_role,
      sandboxId: null,
    },
  };
}

export function defaultLocalUser(): CurrentUser {
  return {
    id: "usr_local",
    email: null,
    name: "Local Intern User",
    profilePicture: null,
    viewer: {
      userId: "usr_local",
      appId: null,
      orgId: null,
      orgName: null,
      orgSlug: null,
      orgRole: null,
      sandboxId: null,
    },
  };
}

export async function startLocalPreviewRuntime(
  checkout: string,
  contract: SiteRuntimeContract,
  user: CurrentUser,
): Promise<RunningSiteRuntime> {
  const site = await startSiteRuntime(checkout, contract);
  try {
    return await startLocalPreviewHost(site, user);
  } catch (error) {
    await site.stop();
    throw error;
  }
}

export async function startLocalPreviewHost(
  site: RunningSiteRuntime,
  initialUser: CurrentUser,
): Promise<RunningSiteRuntime> {
  const sandbox = new MemoryMeImplementation(initialUser);
  const upstream = new URL(site.url);
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, upstream, sandbox).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  const connections = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  let proxyStopped = false;
  let siteStopped = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async stop() {
      const operations: Array<Promise<void>> = [];
      if (!proxyStopped) {
        operations.push(
          closeServerBounded(server, connections).then(() => {
            proxyStopped = true;
          }),
        );
      }
      if (!siteStopped) {
        operations.push(
          site.stop().then(() => {
            siteStopped = true;
          }),
        );
      }
      const results = await Promise.allSettled(operations);
      const errors = results
        .filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )
        .map((result) => result.reason as unknown);
      if (errors.length > 0) {
        throw new AggregateError(errors, "failed to stop local Intern preview");
      }
    },
  };
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  upstream: URL,
  sandbox: MemoryMeImplementation,
): Promise<void> {
  const target = resolveUpstreamURL(request.url ?? "/", upstream);
  const pathname = target.pathname;
  if (pathname === runtimeScriptPath && request.method === "GET") {
    response.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(runtimeScript());
    return;
  }
  if (pathname === meAPIPath) {
    await handleMe(request, response, sandbox);
    return;
  }
  await proxySite(request, response, target);
}

async function handleMe(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  sandbox: MemoryMeImplementation,
): Promise<void> {
  try {
    let value: CurrentUser;
    if (request.method === "GET") {
      value = await sandbox.get();
    } else if (request.method === "PATCH") {
      const body = await readBody(request, maxUpdateBytes);
      value = await sandbox.update(validateUpdate(JSON.parse(body) as unknown));
    } else {
      response.writeHead(405, { allow: "GET, PATCH" }).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(value));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "invalid local ME request",
      }),
    );
  }
}

function proxySite(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  target: URL,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers = { ...request.headers, host: target.host };
    headers["accept-encoding"] = "identity";
    const forwarded = http.request(
      target,
      { method: request.method, headers },
      (upstreamResponse) => {
        const contentType = String(upstreamResponse.headers["content-type"] ?? "");
        if (
          upstreamResponse.statusCode === 200 &&
          contentType.startsWith("text/html")
        ) {
          collectHTML(upstreamResponse)
            .then((body) => {
              const injected = injectRuntime(body);
              const responseHeaders = Object.fromEntries(
                Object.entries(upstreamResponse.headers).filter(
                  ([name]) =>
                    !["content-length", "transfer-encoding", "etag"].includes(
                      name.toLowerCase(),
                    ),
                ),
              );
              response.writeHead(200, responseHeaders);
              response.end(injected);
              resolve();
            })
            .catch(reject);
          return;
        }
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", resolve);
      },
    );
    forwarded.once("error", reject);
    request.pipe(forwarded);
  });
}

function resolveUpstreamURL(requestTarget: string, upstream: URL): URL {
  if (!requestTarget.startsWith("/")) {
    throw new Error("local preview request target must be origin-relative");
  }
  const target = new URL(requestTarget, upstream);
  if (target.origin !== upstream.origin) {
    throw new Error("local preview request target escaped the site runtime");
  }
  return target;
}

function runtimeScript(): string {
  return `(function(){const failure=(code,message)=>Object.assign(new Error(message),{code});const call=async(method,body)=>{const response=await fetch("${meAPIPath}",{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});if(!response.ok)throw new Error("Intern local ME request failed with HTTP "+response.status);return response.json()};const encode=(bytes)=>{let binary="";for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));return btoa(binary)};const me=Object.freeze({get:()=>call("GET"),update:(input)=>call("PATCH",{...input,profilePicture:input.profilePicture&&{data:encode(input.profilePicture.bytes),contentType:input.profilePicture.contentType,filename:input.profilePicture.filename}})});const invoke=async(binding,operation,input)=>{if(binding!=="me")throw failure("plugin_unavailable","Intern local plugin is unavailable: "+binding);if(operation==="get")return me.get();if(operation==="update")return me.update(input);throw failure("plugin_contract_error","Intern local plugin operation is unavailable: "+binding+"."+operation)};const runtime=Object.freeze({protocolVersion:${INTERN_PROTOCOL_VERSION},transport:Object.freeze({version:1,invoke}),plugins:Object.freeze({me})});globalThis.intern=Object.freeze({protocolVersion:${INTERN_PROTOCOL_VERSION},resolveRuntime:()=>runtime})})();`;
}

function injectRuntime(html: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head || head.index === undefined) return runtimeTag + html;
  const index = head.index + head[0].length;
  return html.slice(0, index) + runtimeTag + html.slice(index);
}

async function collectHTML(response: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxHTMLBytes) throw new Error("local preview HTML exceeds limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("local preview request exceeds limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateUpdate(value: unknown): MeUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid local ME update");
  }
  const input = value as Record<string, unknown>;
  const update: DecodedMeUpdate = {};
  if (Object.hasOwn(input, "name")) {
    if (
      input.name !== null &&
      (typeof input.name !== "string" || input.name.length > 200)
    ) {
      throw new Error("invalid local ME name");
    }
    update.name = input.name as string | null;
  }
  if (Object.hasOwn(input, "profilePicture")) {
    update.profilePicture = validatePicture(input.profilePicture);
  }
  if (!Object.hasOwn(update, "name") && !Object.hasOwn(update, "profilePicture")) {
    throw new Error("local ME update is empty");
  }
  return update as MeUpdate;
}

function validatePicture(value: unknown): ProfilePictureUpload | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid local ME profile picture");
  }
  const picture = value as Record<string, unknown>;
  const bytes =
    typeof picture.data === "string" ? decodePictureData(picture.data) : null;
  if (
    !bytes ||
    bytes.length > maxPictureBytes ||
    typeof picture.contentType !== "string" ||
    picture.contentType.length < 1 ||
    picture.contentType.length > 100 ||
    typeof picture.filename !== "string" ||
    picture.filename.length < 1 ||
    picture.filename.length > 255
  ) {
    throw new Error("invalid local ME profile picture");
  }
  return {
    bytes: new Uint8Array(bytes),
    contentType: picture.contentType,
    filename: picture.filename,
  };
}

function decodePictureData(value: string): Buffer | null {
  if (value.length > 4 * Math.ceil(maxPictureBytes / 3)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function closeServerBounded(
  server: http.Server,
  connections: Set<Socket>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(deadlineTimer);
      if (error) reject(error);
      else resolve();
    };
    const destroyConnections = () => {
      for (const socket of connections) socket.destroy();
    };
    const forceTimer = setTimeout(destroyConnections, 250);
    const deadlineTimer = setTimeout(() => {
      destroyConnections();
      finish(new Error("timed out stopping local preview proxy"));
    }, 2_000);
    server.close((error) => finish(error ?? undefined));
  });
}
