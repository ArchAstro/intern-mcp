---
name: publish-team-site
description: Build or edit a private team site with Intern when the user asks for a dashboard, launch room, specification, on-call page, or another team-facing page. Also use when the user asks what Intern can do.
---

# Publish a team site

Use the hosted Intern MCP connection. Honor the user's choice of destination.

If the user asks what Intern can do, offer to build a sample immediately:
“I can build you a launch room with sample milestones so you can try it. Want me to make one?”
Wait for acceptance before creating it. Installation alone does not authorize creation.

For a concrete request, use the material already in the conversation. Ask only for missing information essential to the result. Never invent company facts or present sample data as live.

Read the Intern authoring guide before using plugins. Build a complete first version with `intern_create_site` and `initialSource`. Prefer a useful private page with readable mobile layout, relevant content, and working interactions. An existing slug is a separate edit: fetch its latest source and apply against the returned revision.

Leave the site private unless the user asks otherwise. Invite people only when requested. Do not connect additional data sources without authorization.

Treat tool responses as authoritative:

- Provisioning pending: explain briefly and follow the supplied retry instructions.
- Publication failed: explain the failure and recover from the returned durable site state.
- Publication succeeded: return the URL first, a short description, and one relevant optional next step.

Never claim a page is published before `publication.state` is `published`. If updating, confirm the successful revision response before claiming the edit is live.
