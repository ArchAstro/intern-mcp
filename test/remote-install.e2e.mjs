import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("a remote listing leads an unsigned visitor to Intern OAuth discovery", async () => {
  // Read the shipped connection, then cross the real public HTTPS boundary.
  const registry = JSON.parse(
    await readFile(new URL("../server.json", import.meta.url), "utf8"),
  );
  const endpoint = registry.remotes[0].url;
  assert.equal(endpoint, "https://tryintern.dev/mcp");
  const mcp = JSON.parse(
    await readFile(new URL("../mcp.json", import.meta.url), "utf8"),
  );
  const gemini = JSON.parse(
    await readFile(new URL("../gemini-extension.json", import.meta.url), "utf8"),
  );
  assert.equal(mcp.mcpServers.intern.url, endpoint);
  assert.equal(gemini.mcpServers.intern.httpUrl, endpoint);
  const origin = new URL(endpoint).origin;
  const get = (url) => {
    assert.equal(new URL(url).origin, origin, "discovery must remain on Intern");
    return fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  };

  // No credentials, client registration, token requests, or site writes occur.
  const challenge = await get(endpoint);
  assert.equal(challenge.status, 401);
  const authenticate = challenge.headers.get("www-authenticate");
  assert.match(authenticate, /^Bearer /i);
  const metadataUrl = authenticate.match(/resource_metadata="([^"]+)"/)?.[1];
  assert.equal(metadataUrl, `${origin}/.well-known/oauth-protected-resource/mcp`);
  const resourceResponse = await get(metadataUrl);
  assert.equal(resourceResponse.status, 200);
  const resource = await resourceResponse.json();
  assert.equal(resource.resource, endpoint);
  assert.deepEqual(resource.authorization_servers, [origin]);
  assert.ok(resource.bearer_methods_supported.includes("header"));

  // The advertised issuer must supply the endpoints a real host needs next.
  const issuerResponse = await get(
    `${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`,
  );
  assert.equal(issuerResponse.status, 200);
  const issuer = await issuerResponse.json();
  assert.equal(issuer.issuer, origin);
  assert.equal(issuer.authorization_endpoint, `${origin}/oauth/authorize`);
  assert.equal(issuer.token_endpoint, `${origin}/oauth/token`);
  assert.equal(issuer.registration_endpoint, `${origin}/oauth/register`);
  assert.ok(issuer.response_types_supported.includes("code"));
  assert.ok(issuer.grant_types_supported.includes("authorization_code"));
  assert.ok(issuer.code_challenge_methods_supported.includes("S256"));
  assert.ok(issuer.token_endpoint_auth_methods_supported.includes("none"));
});
