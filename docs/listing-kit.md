# Listing kit

Copy and category picks for submitting Intern to MCP directories. Same voice
throughout: plain sentences, no em dashes, no exclamation marks, no "simply".

## Tagline (40 characters)

Build private team sites with your agent

## Description (135 characters)

Give your coding agent an MCP server that builds and publishes private team sites, with sign-in, a database, and file storage built in.

## Long description (579 characters)

Intern is a hosted MCP server at https://tryintern.dev/mcp that lets AI coding agents build private internal sites for a company: reports, dashboards, trackers, on-call pages, specs, and prototypes. Each site gets company sign-in, a database, file storage, and a durable URL under the company name, so agents can hand back a working page instead of a deck or a spreadsheet. Connect with OAuth 2.0 and dynamic client registration over Streamable HTTP, or install the local @archastro/intern-mcp npm package for a git based workflow with commits you can review before they publish.

## Category and tag suggestions, per directory

Directory category taxonomies change without notice. Entries marked
"doc-checked" were confirmed against a live page or listing on 2026-09-09;
entries marked "best guess" were not independently confirmed and should be
checked at submission time.

### MCP Registry (registry.modelcontextprotocol.io)

Doc-checked: the registry has no category taxonomy. Discovery is by search
over `name`, `description`, and `title` in `server.json` (confirmed against
[modelcontextprotocol.io/registry/remote-servers](https://modelcontextprotocol.io/registry/remote-servers)
and the registry search endpoint shown in the
[quickstart](https://modelcontextprotocol.io/registry/quickstart)). No tags
field exists in the current schema; the description and title copy above are
what carries the listing.

### Smithery

Best guess, from a general search of `smithery.ai/servers`, not a fetched
taxonomy page: **Productivity**, with **Developer Tools** as a secondary
category. Verify the current category list at
[smithery.ai/servers](https://smithery.ai/servers) before submitting, since
category names were not independently confirmed this pass.

Suggested tags: `internal-tools`, `dashboards`, `team-sites`, `site-builder`,
`remote-mcp`.

### Glama

Doc-checked against the filter sidebar at
[glama.ai/mcp/servers](https://glama.ai/mcp/servers): **App Automation** as
primary category, **Project Management** as secondary. Glama badges are
issued once Glama has indexed the repository, so the badge in the
awesome-mcp-servers line below may need to be added after first indexing
rather than at initial submission.

Suggested tags: `internal-tools`, `dashboards`, `reports`, `trackers`,
`streamable-http`, `oauth`.

### mcp.so

Best guess: **Productivity** or **Business**, matching mcp.so's general
category pattern for internal-tool and dashboard servers. The mcp.so
directory page returned an HTTP 403 to automated fetches this pass, so this
was not confirmed against a live category list; check the actual category
picker at submission time.

Suggested tags: `internal-tools`, `dashboards`, `team-sites`.

### MCP Market

Best guess: **Productivity** or **Developer Tools**. No live taxonomy page
was fetched for MCP Market this pass; confirm at submission time.

Suggested tags: `internal-tools`, `dashboards`, `remote-mcp`.

### AI Agents Listing

Best guess: **Productivity Tools** or **Developer Tools**, matching the
general split most agent-tool directories use. No live taxonomy page was
fetched for this directory this pass; confirm at submission time.

Suggested tags: `internal-tools`, `team-sites`, `mcp-server`.

### awesome-mcp-servers

Doc-checked against the raw
[README.md](https://github.com/punkpeye/awesome-mcp-servers/blob/main/README.md)
on 2026-09-09. Intern MCP has an installable GitHub-hosted package
(`@archastro/intern-mcp`), so it belongs in this list rather than in the
sibling
[awesome-remote-mcp-servers](https://github.com/punkpeye/awesome-remote-mcp-servers)
list, which the CONTRIBUTING.md reserves for remote-only servers with no
installable package.

Category: **🏢 Workplace & Productivity** (`workplace-and-productivity`),
alongside comparable entries like `backloghq/backlog` and
`wisflux/docmost-local-mcp`. Alphabetical order within the section, by
repository name.

Entry line, matching the existing format (link, language/scope/OS legend,
description, install command; the Glama badge can be added once Glama has
indexed the repo):

```markdown
- [ArchAstro/intern-mcp](https://github.com/ArchAstro/intern-mcp) 📇 ☁️ 🏠 🍎 🪟 🐧 - Build private team sites with your agent. Each site gets company sign-in, a database, file storage, and a durable URL. Hosted MCP at `https://tryintern.dev/mcp`, published as `dev.tryintern/intern` in the official MCP Registry. Install: `npx -y @archastro/intern-mcp@latest setup --host codex`.
```

PR title, with the agent fast track suffix confirmed verbatim from
[CONTRIBUTING.md](https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md)
("Just add `🤖🤖🤖` to the end of the PR title to opt-in. Merging your PR will
be fast-tracked."):

```
Add Intern MCP server 🤖🤖🤖
```

## Smithery manifest check

Task: confirm whether `smithery.yaml` is required to publish or list Intern
on Smithery. Finding: no, not for a server that is already hosted elsewhere.

Smithery's publish API
([smithery.ai/docs/api-reference/servers/publish-a-server](https://smithery.ai/docs/api-reference/servers/publish-a-server.md))
takes a release type: hosted (Smithery builds and runs a JS module it is
given), external (a URL Smithery does not host or build), or stdio (an MCPB
bundle). `smithery.yaml` with a `runtime: container` block is what Smithery's
own build step reads for the hosted release type; it has no role in an
external release, which just registers the existing `https://tryintern.dev/mcp`
URL against the server record over the API. This repository ships no
`smithery.yaml`, and none should be added unless Intern later asks Smithery
to build and host a copy of the server itself, which is not the plan here.

## Human steps, across every directory in this kit

- MCP Registry: create the `tryintern.dev` DNS TXT record, then run
  `mcp-publisher login dns` and `mcp-publisher publish`. See
  `docs/registry-publish.md` for the exact commands.
- Smithery, Glama, mcp.so, MCP Market, AI Agents Listing: each needs a
  publisher account signed in as a human, plus a final look at whatever
  category picker and copy fields that account sees, since taxonomies were
  not all independently confirmed this pass (see "best guess" notes above).
- awesome-mcp-servers: a human forks the repository, adds the entry line
  above under Workplace & Productivity in alphabetical order, and opens the
  PR with the title above. No account beyond a personal GitHub account is
  needed, but a human should still review the rendered PR before it is
  fast-tracked.
- Every directory: confirm the icon at `https://tryintern.dev/brand-mark.svg`
  renders correctly in that directory's card size before submitting, since
  none of this pass's fetches rendered the icon visually.
