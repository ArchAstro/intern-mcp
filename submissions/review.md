# Intern remote listing review

Status: prepared locally; no directory submissions made.

Connection: https://tryintern.dev/mcp
Repository: https://github.com/ArchAstro/intern-mcp
Name: Intern
Description: Build private team sites with your agent.

## First run

Concrete request: “Turn this release plan into a private launch room.”
Expected: use supplied material, publish a complete page, return the private URL.

Exploration: “What can Intern do?”
Expected: offer to build a sample immediately and wait for acceptance.

Vivek should review an actual first-run conversation and resulting site before this copy is submitted.

## Positive review scenarios

1. Create a launch room from supplied milestones. Verify a published private URL.
2. Build a dashboard from an attached CSV. Values must match the file; no invented live connection.
3. Create an on-call page using supplied incident details.
4. Edit an existing site after reading the latest source revision.
5. Invite a named teammate only when the user explicitly requests it.

## Negative review scenarios

1. Connect without a creation request. No sample site is created.
2. Request a site without enough business data. Ask for what is essential or label sample data.
3. Simulate publication failure. Report the failure and retain the recoverable site identity; no success claim.

## Human decisions

- The repository uses MIT, matching ArchAstro/intern-sdk, with the same ArchAstro copyright notice. Publisher policy attestations still need human approval.
- Confirm publisher account ownership, policy links, and reviewer account access per directory.
- Approve the final listing copy and actual first-run experience.

## External dependencies

- Hosted Gemini OAuth issuer fix must deploy before Gemini acceptance testing.
- Required hosted discovery changes must deploy before submissions that depend on them.
- Each host must be installed and tested in a clean profile. JSON validation alone is not host acceptance.

## Submission routes

Checked against official documentation on September 8, 2026. All routes below are
prepared, not submitted. Use the remote endpoint above; do not submit the local
stdio package as if it were the hosted connector.

| Destination             | What to submit                                                                                                                                                                                                                                                                                          | Remaining human input                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude directory        | Submit the remote MCP in the [Claude portal](https://claude.ai/admin-settings/directory/submissions/new). [Requirements](https://claude.com/docs/connectors/building/submission)                                                                                                                        | Team/Enterprise organization with directory-management access; support contact, approved policy links, icon, working reviewer account and first-run evidence.                                                                                                                                |
| OpenAI, including Codex | Submit an MCP-backed plugin in the [OpenAI portal](https://platform.openai.com/plugins), optionally with `skills/publish-team-site`. No custom UI is required. Approved publication reaches the shared ChatGPT/Codex directory. [Requirements](https://developers.openai.com/plugins/deploy/submission) | Verified publisher identity, Apps Management write permission, availability countries, support/privacy/terms links and attestations. Review credentials must work without MFA or email/SMS confirmation: agree a supported review arrangement before submitting; do not weaken normal login. |
| Gemini CLI gallery      | Merge root `gemini-extension.json`, then add the GitHub topic `gemini-cli-extension`. The gallery indexes matching public repositories daily, subject to validation. [Release guide](https://geminicli.com/docs/extensions/releasing/)                                                                  | Repository admin permission to add the topic; approve timing after a real Gemini OAuth connection succeeds. This is Gemini CLI distribution, not a promise of a Gemini web-app listing.                                                                                                      |
| Official MCP Registry   | Publish `server.json` as `dev.tryintern/intern`. Use [domain authentication](https://modelcontextprotocol.io/registry/authentication) and the [remote-server publishing guide](https://modelcontextprotocol.io/registry/remote-servers).                                                                | Domain owner must approve DNS or HTTPS ownership proof and retain the signing key securely. Do not generate or publish a new ownership key casually.                                                                                                                                         |
| Cursor Marketplace      | Submit this repository through [Cursor publishing](https://cursor.com/marketplace/publish). Current [Cursor documentation](https://cursor.com/docs/reference/plugins) accepts root `plugin.json` plus `mcp.json`; a duplicate `.cursor-plugin` manifest is unnecessary.                                 | Publisher login, approved listing copy and icon, successful connection in a clean Cursor profile.                                                                                                                                                                                            |
| Grok                    | Promote the direct connection at `/connect` and test it in Grok Bot and Grok Build separately. [Grok Build MCP documentation](https://docs.x.ai/build/features/mcp-servers) documents remote OAuth; [Grok Bot documentation](https://docs.x.ai/grok-bot/overview) describes connectors.                 | Access to the intended Grok product for the actual browser handoff. No public Grok Bot directory submission route was verified; do not promise one or substitute API compatibility for Bot testing.                                                                                          |

For secondary distribution, [Glama's connector route](https://glama.ai/mcp/faq)
accepts a deployed remote endpoint. [Smithery](https://www.smithery.ai/docs/api-reference/servers/publish-a-server)
supports external URL releases. Both need the publisher's account and a review
of any proxy/credential handling before use. Keep Intern's direct endpoint as
the primary connection. PulseMCP is worth a listing check after Registry
publication; its submission route was not verified in this pass.

## Assets and verification

- Name: **Intern**
- Tagline: **Send a site, not a deck**
- Short description: **Build private team sites with your agent.**
- Website: https://tryintern.dev
- Connection help: https://tryintern.dev/connect
- Existing product icon: https://tryintern.dev/brand-mark.svg
- License: [MIT](../LICENSE), matching [Intern SDK](https://github.com/ArchAstro/intern-sdk/blob/main/LICENSE)

`npm run test:distribution` checks the manifest endpoint, metadata agreement,
license and continued presence of the local executable. Root `plugin.json` and
`mcp.json` target Agent Plugins 1.0.0; `server.json` targets the official
2025-12-11 Registry schema. Gemini's `httpUrl` form follows its
[MCP configuration reference](https://geminicli.com/docs/tools/mcp-server/).

On September 8, 2026, all three JSON-schema manifests passed validation against
their published schemas, including URI format checks. Gemini CLI 0.46.0 linked
this checkout in an isolated temporary profile and recognized both the remote
server and `publish-team-site` skill. That checks packaging, not Gemini login.

Canonical read-only network proof: [`test/remote-install.e2e.mjs`](../test/remote-install.e2e.mjs),
`a remote listing leads an unsigned visitor to Intern OAuth discovery`.
It reads the manifests, contacts production, receives a 401 challenge, follows
protected-resource discovery, and checks the issuer's OAuth endpoints and PKCE
support. It makes no customer writes. It does not test sign-in, token exchange,
tool use or a particular agent. Those remain required acceptance checks before
claiming host compatibility.

Keep reviewer credentials out of this repository. Enter them only in the
destination's private review fields.
