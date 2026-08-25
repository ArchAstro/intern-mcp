import { createServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { build } from "vite";

const mcpRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = resolve(
  process.argv[2] ??
    process.env.INTERN_SDK_REPOSITORY ??
    "node_modules/@archastro/intern-sdk",
);
const testD1 =
  process.argv[2] !== undefined || process.env.INTERN_SDK_REPOSITORY !== undefined;
const sdkEntry = join(sdkRoot, "dist", "index.js");
const previewEntry = join(mcpRoot, "dist", "preview.js");
await Promise.all([access(sdkEntry), access(previewEntry)]).catch(() => {
  throw new Error(
    "Build both repositories first, then run npm run test:sdk -- /path/to/intern-sdk",
  );
});

const fixture = await realpath(
  await mkdtemp(join(tmpdir(), "intern-sdk-mcp-browser-")),
);
const source = join(fixture, "src");
await mkdir(source);
await writeFile(
  join(fixture, "index.html"),
  '<!doctype html><html><head><meta charset="UTF-8"><title>SDK compatibility</title></head><body><h1 id="name"></h1><img id="picture"><div id="role"></div><div id="database"></div><script type="module" src="/src/main.js"></script></body></html>',
);
await writeFile(
  join(source, "main.js"),
  `import Client from "@archastro/intern-sdk";
const client = new Client();
const initial = await client.me.get();
const updated = await client.me.update({
  name: "Same Bundle",
  profilePicture: {
    bytes: new Uint8Array([0, 255]),
    contentType: "image/png",
    filename: "avatar.png",
  },
});
${
  testD1
    ? `await client.d1.exec("CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT)");
await client.d1.prepare("INSERT INTO proof (value) VALUES (?)").bind("persisted").run();
const databaseValue = await client.d1.prepare("SELECT value FROM proof WHERE id = ?").bind(1).first("value");`
    : `const databaseValue = "not-tested";`
}
document.querySelector("#name").textContent = updated.name;
document.querySelector("#picture").src = updated.profilePicture.url;
document.querySelector("#role").textContent = initial.viewer.orgRole ?? "local";
document.querySelector("#database").textContent = databaseValue;
document.body.dataset.ready = "true";
`,
);

let preview;
let browser;
let staticServer;
try {
  await build({
    root: fixture,
    logLevel: "silent",
    resolve: { alias: { "@archastro/intern-sdk": sdkEntry } },
    build: { outDir: "dist", emptyOutDir: true },
  });
  const dist = join(fixture, "dist");
  staticServer = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://site.test").pathname;
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      if (relative.includes("..")) throw new Error("unsafe fixture path");
      const body = await readFile(join(dist, relative));
      response.writeHead(200, {
        "content-type": contentType(relative),
        "content-security-policy": "script-src 'self'",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
  const address = staticServer.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  let staticStopped = false;
  const { defaultLocalUser, startLocalPreviewHost } = await import(
    pathToFileURL(previewEntry).href
  );
  preview = await startLocalPreviewHost(
    {
      url: `http://127.0.0.1:${address.port}`,
      port: address.port,
      async stop() {
        if (staticStopped) return;
        staticStopped = true;
        await closeServer(staticServer);
      },
    },
    defaultLocalUser(),
    [
      {
        binding: "me",
        plugin: "me",
        protocolVersion: 1,
        config: {},
        state: "active",
        errorCode: null,
      },
      {
        binding: "d1",
        plugin: "d1",
        protocolVersion: 1,
        config: {},
        state: "active",
        errorCode: null,
      },
    ],
  );
  const previewURL = preview.url;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.goto(preview.url);
  await page.locator("body[data-ready=true]").waitFor();
  if ((await page.locator("#name").textContent()) !== "Same Bundle") {
    throw new Error("client.me update did not cross the MCP preview boundary");
  }
  if (
    (await page.locator("#picture").getAttribute("src")) !==
    "data:image/png;base64,AP8="
  ) {
    throw new Error("profile picture bytes did not survive the MCP preview boundary");
  }
  if (testD1 && (await page.locator("#database").textContent()) !== "persisted") {
    throw new Error("client.d1 query did not cross the MCP preview boundary");
  }
  if (
    (await page.evaluate(() => typeof globalThis.intern?.resolveRuntime)) !== "function"
  ) {
    throw new Error("preview did not inject the SDK host resolver");
  }
  await preview.stop();
  preview = undefined;
  await fetch(previewURL, {
    signal: AbortSignal.timeout(500),
  }).then(
    () => {
      throw new Error("preview stop left the site runtime reachable");
    },
    () => undefined,
  );
  process.stdout.write(
    "same committed Client bundle ran through the Intern MCP browser runtime\n",
  );
} finally {
  await browser?.close();
  await preview?.stop().catch(() => undefined);
  if (staticServer?.listening) await closeServer(staticServer).catch(() => undefined);
  await rm(fixture, { recursive: true, force: true });
}

function contentType(pathname) {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
    }[extname(pathname)] ?? "application/octet-stream"
  );
}

function closeServer(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
