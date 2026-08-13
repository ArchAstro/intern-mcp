# AGENTS.md

## Scope

This repository owns the local TryIntern MCP package. TryIntern and Platform
backend APIs remain in Firstlanding.

## Verification

Run `npm run check` for source changes. Run `npm run test:harnesses` when
changing packaging, the executable, or Codex/Claude installation guidance.
When Firstlanding's runtime contract changes, run
`node scripts/runtime-contract.mjs sync <firstlanding-path>`, verify it with
`npm run check:runtime-contract -- <firstlanding-path>`, and update both
repositories together.

The MCP uses stdout only for protocol frames. Diagnostics belong on stderr.
Keep explicit stdin and signal shutdown so preview processes and snapshots are
always cleaned up.

## Git

Do not commit or push unless the user explicitly asks. Rebase feature branches
against `origin/main` before updating a pull request.
