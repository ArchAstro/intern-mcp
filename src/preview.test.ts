import http from "node:http";
import { afterEach, expect, test } from "vitest";
import { defaultLocalUser, startLocalPreviewHost } from "./preview.js";
import type { RunningSiteRuntime } from "./validation.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("local preview injects the host resolver and isolates its in-memory ME store", async () => {
  let escapedRequest = false;
  const escapeTarget = http.createServer((_request, response) => {
    escapedRequest = true;
    response.end("must not be reachable");
  });
  await new Promise<void>((resolve) => escapeTarget.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve, reject) =>
        escapeTarget.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const escapeAddress = escapeTarget.address();
  if (!escapeAddress || typeof escapeAddress === "string") {
    throw new Error("escape target did not bind");
  }
  const upstream = http.createServer((request, response) => {
    if (request.url === "/asset.txt") {
      response.writeHead(200, { "content-type": "text/plain" }).end("asset");
      return;
    }
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "script-src 'self'",
      })
      .end(
        "<!doctype html><html><head><title>Local</title></head><body>site</body></html>",
      );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("upstream did not bind");
  let upstreamStopped = false;
  const site: RunningSiteRuntime = {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async stop() {
      if (upstreamStopped) return;
      upstreamStopped = true;
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  const preview = await startLocalPreviewHost(site, defaultLocalUser());
  cleanups.push(() => preview.stop());

  // Host boundary: the checkout's HTML and asset bytes remain upstream-owned;
  // the preview adds only the external runtime bootstrap to HTML documents.
  const htmlResponse = await fetch(preview.url);
  const html = await htmlResponse.text();
  expect(htmlResponse.headers.get("content-security-policy")).toBe("script-src 'self'");
  expect(html).toContain(
    '<head><script src="/.intern/runtime.js"></script><title>Local</title>',
  );
  expect(await (await fetch(new URL("/asset.txt", preview.url))).text()).toBe("asset");

  // Runtime boundary: the injected host resolves protocol v1 and delegates ME
  // calls to the MCP process rather than embedding state in committed files.
  const runtimeScript = await (
    await fetch(new URL("/.intern/runtime.js", preview.url))
  ).text();
  expect(runtimeScript).toContain("resolveRuntime");
  expect(runtimeScript).toContain("protocolVersion:1");
  const updated = await fetch(new URL("/.intern/api/me", preview.url), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Local Ada" }),
  });
  expect(await updated.json()).toMatchObject({ name: "Local Ada" });
  expect(
    await (await fetch(new URL("/.intern/api/me", preview.url))).json(),
  ).toMatchObject({ name: "Local Ada" });

  const invalid = await fetch(new URL("/.intern/api/me", preview.url), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(invalid.status).toBe(400);

  const maximumPicture = Buffer.alloc(8 * 1024 * 1024).toString("base64");
  const maximumUpload = await fetch(new URL("/.intern/api/me", preview.url), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profilePicture: {
        data: maximumPicture,
        contentType: "image/png",
        filename: "maximum.png",
      },
    }),
  });
  expect(maximumUpload.status).toBe(200);
  const maximumProfile = (await maximumUpload.json()) as {
    profilePicture: { url: string };
  };
  expect(maximumProfile.profilePicture.url).toHaveLength(
    "data:image/png;base64,".length + maximumPicture.length,
  );

  const oversizedPicture = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
  const oversizedUpload = await fetch(new URL("/.intern/api/me", preview.url), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profilePicture: {
        data: oversizedPicture,
        contentType: "image/png",
        filename: "oversized.png",
      },
    }),
  });
  expect(oversizedUpload.status).toBe(400);

  const escaped = await absoluteTargetRequest(
    preview.url,
    `http://127.0.0.1:${escapeAddress.port}/secret`,
  );
  expect(escaped.status).toBe(502);
  expect(escapedRequest).toBe(false);

  await preview.stop();
  expect(upstreamStopped).toBe(true);
  await expect(
    fetch(preview.url, { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
});

test("local preview retries an upstream stop failure without leaking its proxy", async () => {
  const upstream = http.createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("upstream did not bind");
  let stopAttempts = 0;
  const site: RunningSiteRuntime = {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async stop() {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error("injected stop failure");
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  const preview = await startLocalPreviewHost(site, defaultLocalUser());

  await expect(preview.stop()).rejects.toThrow("failed to stop local Intern preview");
  await expect(
    fetch(preview.url, { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  await expect(preview.stop()).resolves.toBeUndefined();
  expect(stopAttempts).toBe(2);
});

test("local preview bounds shutdown when a client stalls an active request", async () => {
  const upstream = http.createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("upstream did not bind");
  let upstreamStopped = false;
  const site: RunningSiteRuntime = {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async stop() {
      upstreamStopped = true;
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  const preview = await startLocalPreviewHost(site, defaultLocalUser());
  const previewURL = new URL(preview.url);
  const stalled = http.request({
    host: previewURL.hostname,
    port: previewURL.port,
    path: "/.intern/api/me",
    method: "PATCH",
    headers: { "content-length": "100", "content-type": "application/json" },
  });
  stalled.on("error", () => undefined);
  await new Promise<void>((resolve) => {
    stalled.once("socket", (socket) => {
      if (socket.readyState === "open") resolve();
      else socket.once("connect", resolve);
    });
    stalled.write("{");
  });

  await expect(preview.stop()).resolves.toBeUndefined();
  expect(upstreamStopped).toBe(true);
  stalled.destroy();
});

function absoluteTargetRequest(
  previewURL: string,
  target: string,
): Promise<{ status: number; body: string }> {
  const preview = new URL(previewURL);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: preview.hostname,
        port: preview.port,
        method: "GET",
        path: target,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}
