import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { CurrentUser } from "@archastro/intern-sdk";
import { INTERN_PROTOCOL_VERSION } from "@archastro/intern-sdk/runtime";
import type {
  InternSession,
  SitePluginInstallation,
  SiteRuntimeContract,
} from "./api.js";
import { createLocalPluginSet, type LocalPlugin } from "./local-plugins.js";
import { startSiteRuntime, type RunningSiteRuntime } from "./validation.js";

const runtimeScriptPath = "/.intern/runtime.js";
const invokeAPIPath = "/.intern/api/v1/invoke";
const runtimeTag = `<script src="${runtimeScriptPath}"></script>`;
const maxHTMLBytes = 4 * 1024 * 1024;
const maxInvocationBytes = 12 * 1024 * 1024;

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
  installations?: SitePluginInstallation[],
): Promise<RunningSiteRuntime> {
  const site = await startSiteRuntime(checkout, contract);
  try {
    return await startLocalPreviewHost(site, user, installations);
  } catch (error) {
    await site.stop();
    throw error;
  }
}

export async function startLocalPreviewHost(
  site: RunningSiteRuntime,
  initialUser: CurrentUser,
  installations: SitePluginInstallation[] = [localMeInstallation()],
): Promise<RunningSiteRuntime> {
  const plugins = createLocalPluginSet(installations, initialUser);
  const upstream = new URL(site.url);
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, upstream, plugins.operations).catch(
      (error) => {
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        }
        response.end(error instanceof Error ? error.message : String(error));
      },
    );
  });
  const connections = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    for (const socket of connections) socket.destroy();
    if (server.listening) await closeServerBounded(server, connections).catch(() => {});
    plugins.close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  let proxyStopped = false;
  let siteStopped = false;
  let pluginsStopped = false;
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
      if (!pluginsStopped) {
        plugins.close();
        pluginsStopped = true;
      }
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
  plugins: ReadonlyMap<string, LocalPlugin>,
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
  if (pathname === invokeAPIPath) {
    await handleInvocation(request, response, plugins);
    return;
  }
  await proxySite(request, response, target);
}

async function handleInvocation(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  plugins: ReadonlyMap<string, LocalPlugin>,
): Promise<void> {
  try {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const body = JSON.parse(await readBody(request, maxInvocationBytes)) as {
      binding?: unknown;
      operation?: unknown;
      input?: unknown;
    };
    if (typeof body.binding !== "string" || typeof body.operation !== "string") {
      throw Object.assign(new Error("invalid local plugin invocation"), {
        code: "plugin_contract_error",
      });
    }
    const implementation = plugins.get(body.binding);
    if (!implementation) {
      throw Object.assign(
        new Error(`Intern local plugin is unavailable: ${body.binding}`),
        { code: "plugin_unavailable" },
      );
    }
    const operation = implementation[body.operation];
    if (typeof operation !== "function") {
      throw Object.assign(
        new Error(
          `Intern local plugin operation is unavailable: ${body.binding}.${body.operation}`,
        ),
        { code: "plugin_contract_error" },
      );
    }
    const value = await operation(decodeWire(body.input));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(encodeWire(value)));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "plugin_contract_error";
    response.writeHead(code === "plugin_unavailable" ? 404 : 422, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify({
        code,
        error:
          error instanceof Error ? error.message : "invalid local plugin invocation",
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
  return `(function(){const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";const b64e=(bytes)=>{let out="";for(let i=0;i<bytes.length;i+=3){const a=bytes[i]??0,b=bytes[i+1]??0,c=bytes[i+2]??0,n=(a<<16)|(b<<8)|c;out+=alphabet[(n>>18)&63]+alphabet[(n>>12)&63]+(i+1<bytes.length?alphabet[(n>>6)&63]:"=")+(i+2<bytes.length?alphabet[n&63]:"=")}return out};const b64d=(value)=>{if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new TypeError("Invalid Intern runtime byte encoding");const out=[];for(let i=0;i<value.length;i+=4){const a=alphabet.indexOf(value[i]??""),b=alphabet.indexOf(value[i+1]??""),c=value[i+2]==="="?0:alphabet.indexOf(value[i+2]??""),d=value[i+3]==="="?0:alphabet.indexOf(value[i+3]??""),n=(a<<18)|(b<<12)|(c<<6)|d;out.push((n>>16)&255);if(value[i+2]!=="=")out.push((n>>8)&255);if(value[i+3]!=="=")out.push(n&255)}return Uint8Array.from(out)};const encode=(value,seen=new WeakSet())=>{if(value===undefined)return{type:"undefined"};if(value===null)return{type:"null"};if(typeof value==="boolean"||typeof value==="string")return{type:typeof value,value};if(typeof value==="number"&&Number.isFinite(value))return{type:"number",value};if(value instanceof Uint8Array)return{type:"bytes",value:b64e(value)};if(typeof value!=="object")throw new TypeError("Unsupported Intern runtime value: "+typeof value);if(seen.has(value))throw new TypeError("Intern runtime values cannot contain cycles");seen.add(value);try{if(Array.isArray(value))return{type:"array",value:value.map(child=>encode(child,seen))};const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)throw new TypeError("Intern runtime values must use plain objects");return{type:"object",value:Object.fromEntries(Object.entries(value).map(([key,child])=>[key,encode(child,seen)]))}}finally{seen.delete(value)}};const decode=(wire)=>{switch(wire.type){case"undefined":return undefined;case"null":return null;case"boolean":case"number":case"string":return wire.value;case"bytes":return b64d(wire.value);case"array":return wire.value.map(decode);case"object":{const object=Object.create(null);for(const[key,child]of Object.entries(wire.value))object[key]=decode(child);return object}default:throw new TypeError("Invalid Intern runtime value")}};const invoke=async(binding,operation,input)=>{const response=await fetch("${invokeAPIPath}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({binding,operation,input:encode(input)})});if(!response.ok){let failure={};try{failure=await response.json()}catch{}const error=new Error(failure.error||("Intern plugin invocation failed with HTTP "+response.status));error.code=failure.code||"plugin_contract_error";error.name=error.code==="plugin_unavailable"?"PluginUnavailableError":error.code==="plugin_contract_error"?"PluginContractError":"Error";throw error}return decode(await response.json())};const transport=Object.freeze({version:1,invoke});const safe=(name)=>typeof name==="string"&&!(["then","constructor","prototype","__proto__"].includes(name));const plugins=new Proxy(Object.create(null),{get(_target,binding){if(!safe(binding))return undefined;return new Proxy(Object.create(null),{get(_plugin,operation){if(!safe(operation))return undefined;return(input)=>invoke(binding,operation,input)}})}});const runtime=Object.freeze({protocolVersion:${INTERN_PROTOCOL_VERSION},transport,plugins});globalThis.intern=Object.freeze({protocolVersion:${INTERN_PROTOCOL_VERSION},resolveRuntime:()=>runtime})})();`;
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

function decodeWire(value: unknown, depth = 0): unknown {
  if (
    depth > 64 ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("invalid local runtime value");
  }
  const wire = value as Record<string, unknown>;
  switch (wire.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "boolean":
      if (typeof wire.value !== "boolean") break;
      return wire.value;
    case "number":
      if (typeof wire.value !== "number" || !Number.isFinite(wire.value)) break;
      return wire.value;
    case "string":
      if (typeof wire.value !== "string") break;
      return wire.value;
    case "bytes": {
      if (typeof wire.value !== "string") break;
      const bytes = Buffer.from(wire.value, "base64");
      if (bytes.toString("base64") !== wire.value) break;
      return new Uint8Array(bytes);
    }
    case "array":
      if (!Array.isArray(wire.value)) break;
      return wire.value.map((child) => decodeWire(child, depth + 1));
    case "object":
      if (
        typeof wire.value !== "object" ||
        wire.value === null ||
        Array.isArray(wire.value)
      )
        break;
      return Object.fromEntries(
        Object.entries(wire.value).map(([key, child]) => [
          key,
          decodeWire(child, depth + 1),
        ]),
      );
  }
  throw new Error("invalid local runtime value");
}

function encodeWire(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error("local runtime value exceeds nesting limit");
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };
  if (typeof value === "boolean" || typeof value === "string") {
    return { type: typeof value, value };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { type: "number", value };
  }
  if (value instanceof Uint8Array) {
    return { type: "bytes", value: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) {
    return { type: "array", value: value.map((child) => encodeWire(child, depth + 1)) };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      value: Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          encodeWire(child, depth + 1),
        ]),
      ),
    };
  }
  throw new Error(`unsupported local runtime value: ${typeof value}`);
}

function localMeInstallation(): SitePluginInstallation {
  return {
    binding: "me",
    plugin: "me",
    protocolVersion: 1,
    config: {},
    state: "active",
    errorCode: null,
  };
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
