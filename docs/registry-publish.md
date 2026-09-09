# Publishing server.json to the official MCP Registry

This documents the exact `mcp-publisher` commands for both authentication
routes available to `dev.tryintern/intern`: DNS authentication on the
`tryintern.dev` domain (primary, matches the server name already in
`server.json`), and the GitHub namespace fallback (`io.github.ArchAstro/intern`)
if DNS auth is blocked or delayed.

Sources, checked 2026-09-09:

- [Registry authentication](https://modelcontextprotocol.io/registry/authentication)
- [Registry quickstart](https://modelcontextprotocol.io/registry/quickstart)
- [Publishing remote servers](https://modelcontextprotocol.io/registry/remote-servers)

The registry is in preview; commands and the schema URL can still change.

## Install mcp-publisher

```sh
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" \
  | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

Or `brew install mcp-publisher`. Confirm with `mcp-publisher --help`.

## Route A: DNS authentication on tryintern.dev (primary)

`server.json` already uses the name `dev.tryintern/intern`, which is the
reverse-DNS namespace for `tryintern.dev`. DNS authentication is what proves
ownership of that namespace to the registry.

1. **Generate a signing key.** Run once, from the repository root:

   ```sh
   openssl genpkey -algorithm Ed25519 -out key.pem
   ```

   Keep `key.pem` out of the repository. It is not committed; treat it like
   any other private key.

2. **Derive the TXT record.**

   ```sh
   PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
   echo "tryintern.dev. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
   ```

   This prints the exact TXT record to create. The record name is the bare
   domain `tryintern.dev` (not a `_mcp` or other subdomain); the value has
   three semicolon-separated fields: `v=MCPv1` (fixed), `k=ed25519` (the key
   algorithm), and `p=<base64 public key>` (the 32-byte Ed25519 public key,
   base64-encoded, unique per key generated above).

3. **[Human] Add the TXT record.** Whoever holds DNS for `tryintern.dev`
   creates that record with the domain registrar or DNS provider and waits
   for propagation (usually a few minutes, can take longer).

4. **[Human] Log in with the private key**, once the TXT record resolves:

   ```sh
   MY_DOMAIN="tryintern.dev"
   PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
   mcp-publisher login dns --domain "${MY_DOMAIN}" --private-key "${PRIVATE_KEY}"
   ```

   This step needs a human because it is the moment the registry account
   gets bound to the `tryintern.dev` namespace; it should run under the
   credentials of whoever owns that publishing identity, not an agent
   session.

5. **Publish**, from the repository root where `server.json` lives:

   ```sh
   mcp-publisher publish
   ```

   Expected output: `✓ Server dev.tryintern/intern version 1.0.0`.

6. **Verify:**

   ```sh
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=dev.tryintern/intern"
   ```

Every future publish (a version bump) just needs step 5 run again, using the
same `key.pem`, once the human has logged in once and the session is valid.
Re-run step 4 if the login expires.

## Route B: GitHub namespace fallback (io.github.ArchAstro/intern)

If DNS auth is not ready in time, publish under the GitHub org namespace
instead. This requires a **different** `server.json` name, since GitHub auth
only authorizes `io.github.<user-or-org>/*` names:

```json
{
  "name": "io.github.ArchAstro/intern",
  ...
}
```

1. **[Human] Authenticate**, from the repository root, using an account in
   the `ArchAstro` GitHub org. The official docs do not state which org
   permission level the device flow requires; expect to need org admin and
   confirm with a real login attempt:

   ```sh
   mcp-publisher login github
   ```

   This prints a device code and a `https://github.com/login/device` link.
   A human opens the link, signs in, and enters the code.

2. **Publish:**

   ```sh
   mcp-publisher publish
   ```

Switching between routes A and B later just means changing `server.json`'s
`name` field and republishing; the registry does not merge two names into one
listing. Route A is preferred because `dev.tryintern/intern` matches the
product's own domain and is the name already checked into `server.json` and
covered by `test/distribution-contract.mjs`.

## What needs a human, summarized

- Creating the `tryintern.dev` DNS TXT record (route A, step 3).
- Running `mcp-publisher login dns ...` or `mcp-publisher login github`
  (routes A/B, whichever is used) under the account that should own the
  registry publishing identity.
- Deciding which route to use and, if DNS is chosen, generating and
  safeguarding `key.pem` (it is a durable credential, not a one-time secret).
- Nothing else here is automatable ahead of time: `mcp-publisher publish`
  itself can run from CI once login has happened once and the session or a
  service credential is available, but that is a follow-up, not part of this
  pass.
