# Intern MCP

Local stdio MCP server for working on Intern-hosted sites through guarded Git checkouts.

## Install in a coding harness

Intern MCP is the public `@archastro/intern-mcp` npm package and requires
Node.js 22 or newer. Run one command, replacing `codex` with your host when
needed:

```sh
npx --yes @archastro/intern-mcp@latest setup --host codex
```

Setup opens your browser to sign in to TryIntern and approve the MCP. It also
prints the approval URL and one-time code, so the same command works on a
headless machine: open the printed URL in any browser and enter the code. After
approval, setup verifies the TryIntern session, saves the host registration,
and prints your organization and role.

OAuth credentials live in `~/.config/intern/credentials.json`. The directory
uses mode `0700`, the file uses mode `0600`, and the record is bound to the
Platform issuer and OAuth client that issued it. Intern MCP refreshes the
short-lived access token automatically, including when more than one local
agent starts at the same time. Users do not normally need to sign in again.

### Host commands and next actions

- Codex: run the command above with `setup --host codex`. Start a new Codex task,
  then ask it to run `intern_auth_status`.
- Claude Code: use `setup --host claude`. Start a new Claude Code session, then
  ask it to run `intern_auth_status`.
- Grok: use `setup --host grok`. Start a new Grok session, then ask it to run
  `intern_auth_status`.
- Cursor CLI or the Cursor editor: use `setup --host cursor`. Start a new Cursor
  session, then ask it to run `intern_auth_status`. Both use `~/.cursor/mcp.json`.
- OpenCode: use `setup --host opencode`. Start a new OpenCode session, then ask
  it to run `intern_auth_status`.
- Rovo Dev: use `setup --host rovodev`. Start a new Rovo Dev session, then ask it
  to run `intern_auth_status`.
- Pi: use `setup --host pi`, then run `pi install npm:pi-mcp-adapter`. Start a new
  Pi session, then ask it to run `intern_auth_status`. Pi needs the adapter
  because its core CLI does not speak MCP.

Add `--verbose` to a setup command to print redacted request lifecycle
diagnostics on stderr. Verbose output includes the method, query-free endpoint,
status, duration, and allowlisted response metadata. It never prints access or
refresh tokens, request headers, response bodies, cookies, or the device code.

The TryIntern Connect page remains on the manual-token flow until the new npm
release passes the public-package release gate. This README documents the
prepared package behavior; it does not claim that frontend switch is deployed.

The setup command resolves npm's stable `latest` release and saves a launcher
that checks that channel whenever the MCP host starts. The saved launcher uses
`--prefer-online` to refresh stale package metadata instead of trusting its npx
cache; the one-time setup command does not expose that runtime policy. To pin a
reviewed build instead, run setup with `INTERN_MCP_PACKAGE` set to a complete
package spec such as `@archastro/intern-mcp@0.1.1`, or to a package tarball.

The repository is private; the package is public on npm.

Maintainers run the manual **release** workflow from `main` and choose a patch,
minor, or major bump. It verifies the package, commits the version change on a
release branch, rebase-merges the version-only PR, tags that exact merged commit
as `vX.Y.Z`, and dispatches `publish.yml`. The publish workflow verifies that
the tag and `package.json` agree, publishes through npm Trusted Publishing, and
creates the GitHub Release. npm must configure `ArchAstro/intern-mcp`,
`publish.yml`, and environment `npm-release` as the trusted publisher; no
`NPM_TOKEN` is used.

## Manual and CI authentication

Browser approval is the normal setup path. For CI or a deliberately manual
configuration, create a profile-scoped token on the TryIntern Connect page and
either export it as `INTERN_ACCESS_TOKEN` for `intern-mcp serve`, or opt into
the setup prompt:

```sh
npx --yes @archastro/intern-mcp@latest setup --host codex --token
```

The prompt keeps the token out of shell history and saves the legacy
`~/.config/intern/access-token` file with mode `0600`. Environment credentials
take precedence over stored OAuth credentials. Manual tokens are not placed in
host arguments or host configuration.

Revocation blocks new API calls and SSH certificates immediately; an SSH
certificate already issued can remain valid until its five-minute expiry.

## Troubleshooting npm registry settings

If your user npm configuration maps the `@archastro` scope to a private
registry, override that setting for this public package. The first override lets
npx find setup on public npm; `--registry` saves the same exception in the MCP
launcher:

```sh
npx --yes --@archastro:registry=https://registry.npmjs.org \
  @archastro/intern-mcp@latest setup --host codex \
  --registry https://registry.npmjs.org
```

## Configure the server

The production TryIntern and Platform origins and public OAuth client are built
in. `intern-mcp launch` uses the browser-approved profile written by setup.
`intern-mcp serve` accepts `INTERN_ACCESS_TOKEN` for manual and CI use.

These optional environment values override the defaults for local testing or custom workspace setup:

- `INTERN_BASE_URL` — Intern frontend/API origin.
- `INTERN_WORKSPACE_ROOT` — parent directory for `<org>/<site>` checkouts.
- `INTERN_CONFIG_ROOT` — directory for the access-token profile and SSH material.
- `INTERN_GIT_SSH_COMMAND` — optional per-process SSH command for development or custom SSH setup.
- `INTERN_IAP_ID_TOKEN` (or `IAP_ID_TOKEN`) — Google ID token for the IAP-protected production frontend. It is sent through `Proxy-Authorization` while the ArchAstro bearer remains in `Authorization`.
- `INTERN_SDK_PACKAGE` — development/test override for the SDK package spec. Normal site preparation always resolves `@archastro/intern-sdk@latest` from public npm.

When the base URL, workspace root, config root, or Git SSH command is present
while `setup` runs, the installer saves that nonsecret override in the selected
host's MCP environment. IAP tokens remain manual/CI-only credentials and are
not copied into host configuration by setup.

For development from this repository, install and build with:

```sh
npm ci
npm run build
```

Then configure an MCP host to run:

```text
node /absolute/path/to/intern-mcp/dist/index.js serve
```

For Codex, the checkout-based equivalent is:

```sh
INTERN_MCP_PACKAGE=/absolute/path/to/intern-mcp \
  INTERN_WORKSPACE_ROOT=/absolute/path/to/Intern \
  node /absolute/path/to/intern-mcp/dist/index.js setup --host codex
```

Restart Codex after adding the server. Call `intern_auth_status`, then use
`intern_prepare_site` and edit the returned absolute path with the coding
host's normal filesystem tools. The prepare result includes validation against
the authenticated Intern runtime contract. Preparation contacts public npm with
`--prefer-online`, resolves `@archastro/intern-sdk@latest`, and writes the exact
resolved version to `devDependencies` plus `package-lock.json`. It uses
`--package-lock-only`, so `node_modules` never enters the guarded checkout.

## Run against a local Firstlanding stack

The backend still lives in Firstlanding. With Aster 0.11.1 or newer, start one
Intern topology in that worktree and point this repository's launcher at it:

```sh
# Terminal 1, from the Firstlanding worktree
aster services up intern

# Or run intern-data on this machine
# aster services up intern-local

# Terminal 2, from this repository
INTERN_PLATFORM_WORKSPACE=../firstlanding-wt2 scripts/run-local.sh
```

`INTERN_PLATFORM_WORKSPACE` identifies the exact worktree whose Aster
supervisor owns the local ports. The supervisor remains attached while the MCP
launcher connects to it.

Each Intern group owns Platform, TryIntern, control, and the Git gateway under
one atomic Aster port allocation. The launcher uses
`aster --json services ports`; it does not assume the default Platform,
TryIntern, or Git gateway SSH ports. Both Intern topologies expose the same API
and Git contract to the MCP; only the control plane's site provider changes.
For local Git, the launcher routes `git.intern.dev` SSH traffic to the reported
loopback gateway port. The launcher requires `INTERN_ACCESS_TOKEN`, builds the
MCP, and keeps its SSH material and site checkouts under this repository's
ignored `tmp/` directory. Create the token from the local Intern Connect page,
export it in the terminal that starts the launcher, and keep it out of shell
scripts and source control. `INTERN_CONFIG_ROOT` and `INTERN_WORKSPACE_ROOT`
still override the default paths.

The same launcher exposes the standalone commands for manual checks:

```sh
INTERN_PLATFORM_WORKSPACE=../firstlanding-wt2 scripts/run-local.sh status
```

After edits, call `intern_test_site` before committing. It validates tracked and untracked working-tree files, excludes ignored files, skips tracked files that were deleted on disk, and returns an ephemeral `http://127.0.0.1:<port>` preview URL. When the site has a `build` script, the MCP installs `devDependencies` locally, runs that build, and writes `dist/` into the checkout so it can be committed. Compatible Intern-owned runtime file upgrades are written the same way. The preview host serves the snapshot unchanged behind a loopback proxy, injects the `globalThis.intern` runtime resolver before application modules, and backs `client.me` with an MCP-owned in-memory sandbox. The runtime bootstrap and sandbox never enter the checkout or committed build. Calling the tool again replaces both the snapshot and sandbox. `intern_stop_test` stops them without needing the backend or a current token. Stdio shutdown also stops every preview and removes its snapshot.

Site code that needs the current user installs `@archastro/intern-sdk` as a
`devDependency`, default-imports `Client`, and uses `new Client().me`. It must
not add a local adapter, production adapter, or `globalThis.intern` assignment
to the repository. Vite bundles the SDK into `dist/`; local and production
hosts inject their implementations outside those committed bytes.

Once the local result is correct, commit the change — including `dist/` when the preview wrote it — and call `intern_validate_site`. It checks the exact committed tree: required and protected runtime files, dependencies the backend does not install, committed build output when a build script exists, JavaScript syntax, production-style startup, and an HTTP probe. `intern_publish_site` reruns the same commit validation and refuses invalid or dirty worktrees. The MCP never stages or commits files. The tenant serves the committed tree and does not install packages or build.

For each SSH clone or push, Intern MCP creates or reuses one local Ed25519 key and sends only its public half to Intern. Intern returns a five-minute user certificate plus the pinned `git.tryintern.dev` host key. MCP supplies those files only to that Git process; it never edits global Git config, `~/.ssh/config`, or the user's `known_hosts`. The MCP replaces the current certificate as needed and retains the private key for future short-lived certificates.

The current runtime contract is deliberately narrow: Intern runs its protected `server.mjs` through `run-site.sh`, supplies `PORT`, and does not install package dependencies on the tenant. `server.mjs` serves `dist/` when `dist/index.html` exists, otherwise the site root, and maps common static types (including `.svg`, `.woff2`, and `.png`). A model can edit HTML, CSS, browser JavaScript, and assets; the MCP runs the local Vite build so those assets can be committed. Runtime launcher changes are rejected because the current Git publish path does not restart the site process.

In production, `intern-fe` authenticates to private `intern-ctl` gRPC with a Google service-account ID token bound to the control audience and forwards actor fields only after resolving the user at the HTTPS edge. Aster uses an explicit `archastro-dev` override. Git clone and publish use the short-lived SSH user certificates described above. The local launcher overrides that path for Aster's development gateway; an explicit `INTERN_GIT_SSH_COMMAND` still takes precedence.

## Development checks

Run the complete local gate from the repository root:

```sh
npm run check
```

When changing the injected SDK protocol, build the sibling SDK and run the
cross-repository proof:

```sh
npm run test:sdk
```

Pass a sibling checkout path only while developing both repositories before
the MCP dependency is pinned to a reviewed SDK commit.

It checks formatting and lint, builds TypeScript, runs the test suite, packs the
npm artifact, installs it into a clean temporary consumer,
launches its installed binary over real MCP stdio, and lists its tools. The
CI also installs the pinned Codex and Claude CLIs and runs
`npm run test:harnesses`. That proof asks both real harnesses to register the
tarball in isolated temporary user profiles; Claude must connect successfully.
The script never changes the operator's real Codex or Claude configuration.

## Runtime-contract fixture

Firstlanding's `services/go/intern-data/internal/sites/runtime-contract.json`
owns the backend contract. This repository keeps a byte-for-byte fixture so
its fail-closed parser, validator, and Git tests exercise the current protected
runtime. When the backend contract changes, update the two repositories in the
same change set:

```sh
node scripts/runtime-contract.mjs sync ../firstlanding-wt2
npm run check:runtime-contract -- ../firstlanding-wt2
npm run check
```

Firstlanding's canonical `scripts/intern/e2e-local.sh` crosses the live backend
and this sibling checkout. It is the compatibility proof; the fixture is not a
second source of truth.
