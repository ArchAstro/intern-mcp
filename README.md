# Intern MCP

Local stdio MCP server for working on Intern-hosted sites through guarded Git checkouts.

## Install in a coding harness

Intern MCP is packaged for distribution as the public
`@archastro/intern-mcp` npm package.
It requires Node.js 22 or newer.

### Codex

```sh
npx --yes @archastro/intern-mcp@0.1.0 setup --host codex
```

Restart Codex after adding the server. Codex stores the stdio command in its
user configuration and starts the package when a session needs the server.

### Claude Code

```sh
npx --yes @archastro/intern-mcp@0.1.0 setup --host claude
```

The installer uses Claude Code's user scope, so Intern is available in every
project. Run `/mcp` inside Claude Code to inspect the connection.

Create a profile access token at <https://tryintern.dev/connect>, copy it, then
run the command for your host. The installer validates the token, configures the
host through its native CLI, verifies the saved registration, and prints the
Intern organization and role. Paste the token at the hidden terminal prompt so
it never enters shell history. Intern displays it only once. The host stores it
through the `intern-mcp launch` profile command. The bearer itself lives in
`~/.config/intern/access-token` with mode `0600`; it is never placed in child
process arguments or host configuration.

The two harnesses launch the same local stdio executable. Intern MCP does not
run an OAuth flow or accept a token through a tool call. To rotate access, run
setup with a new token, restart the host, and revoke the old token on the
Connect page. Revocation blocks new API calls and SSH certificates immediately;
a Git certificate already issued can remain valid until its five-minute expiry.

Upgrades are explicit: rerun the corresponding setup command with the reviewed
version replacing `0.1.0`. The installer updates only the user-level `intern`
registration. The host never executes a newly published package version merely
because it restarted.

The repository is private and the npm package has not been published yet. The
commands above become available after the first package release.

If a developer machine maps the `@archastro` scope to another registry, override
that local mapping for this public package:

```sh
npx --yes --@archastro:registry=https://registry.npmjs.org \
  @archastro/intern-mcp@0.1.0 setup --host codex
```

Maintainers run the manual **release** workflow to publish the version in
`package.json`. The first release uses a short-lived `NPM_TOKEN` repository
secret in the protected `npm-release` environment because npm cannot attach a
trusted publisher to a package that does not exist. That environment accepts
only protected branches; `main` itself requires CI and approving review. After
`0.1.0`, configure `ArchAstro/intern-mcp`, `release.yml`, and environment
`npm-release` as the npm trusted publisher, remove the secret, and later runs
authenticate with GitHub OIDC.

## Configure the server

The production TryIntern origin is built in. `INTERN_ACCESS_TOKEN` is required
for authenticated API calls and should be a profile-scoped token created on the
Connect page. `intern-mcp serve` reads it directly from the environment for
manual and CI configurations. `intern-mcp launch` reads the mode-0600 profile
written by setup, then supplies the same token contract internally.

These optional environment values override the defaults for local testing or custom workspace setup:

- `INTERN_BASE_URL` — Intern frontend/API origin.
- `INTERN_WORKSPACE_ROOT` — parent directory for `<org>/<site>` checkouts.
- `INTERN_CONFIG_ROOT` — directory for the access-token profile and SSH material.
- `INTERN_GIT_SSH_COMMAND` — optional per-process SSH command for development or custom SSH setup.
- `INTERN_IAP_ID_TOKEN` (or `IAP_ID_TOKEN`) — Google ID token for the IAP-protected production frontend. It is sent through `Proxy-Authorization` while the ArchAstro bearer remains in `Authorization`.

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
the authenticated Intern runtime contract.

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

After edits, call `intern_test_site` before committing. It validates tracked and untracked working-tree files, excludes ignored files, and returns an ephemeral `http://127.0.0.1:<port>` preview URL. The URL serves a temporary snapshot, so call the tool again after further edits. `intern_stop_test` stops it without needing the backend or a current token. Stdio shutdown also stops every preview and removes its snapshot.

Once the local result is correct, commit the change and call `intern_validate_site`. It checks the exact committed tree: required and protected runtime files, dependencies the backend does not install, JavaScript syntax, production-style startup, and an HTTP probe. `intern_publish_site` reruns the same commit validation and refuses invalid or dirty worktrees. The MCP never stages or commits files.

For each SSH clone or push, Intern MCP creates or reuses one local Ed25519 key and sends only its public half to Intern. Intern returns a five-minute user certificate plus the pinned `git.tryintern.dev` host key. MCP supplies those files only to that Git process; it never edits global Git config, `~/.ssh/config`, or the user's `known_hosts`. The MCP replaces the current certificate as needed and retains the private key for future short-lived certificates.

The current runtime contract is deliberately narrow: Intern runs its protected `server.mjs` through `run-site.sh`, supplies `PORT`, and does not install package dependencies. A model can edit HTML, CSS, browser JavaScript, and assets. Runtime launcher changes are rejected because the current Git publish path does not restart the site process.

In production, `intern-fe` authenticates to private `intern-ctl` gRPC with a Google service-account ID token bound to the control audience and forwards actor fields only after resolving the user at the HTTPS edge. Aster uses an explicit `archastro-dev` override. Git clone and publish use the short-lived SSH user certificates described above. The local launcher overrides that path for Aster's development gateway; an explicit `INTERN_GIT_SSH_COMMAND` still takes precedence.

## Development checks

Run the complete local gate from the repository root:

```sh
npm run check
```

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
