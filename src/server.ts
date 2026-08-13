import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { AuthClient } from "./auth.js";
import type { InternAPI } from "./api.js";
import type { WorkspaceManager } from "./workspace.js";

const sessionSchema = z.object({
  user: z.object({
    id: z.string(),
    org: z.string(),
    org_name: z.string(),
    org_role: z.enum(["admin", "member", "viewer"]),
  }),
  org: z.object({ id: z.string(), slug: z.string(), state: z.string() }),
});
const siteSchema = z.object({
  id: z.string(),
  orgSlug: z.string(),
  slug: z.string(),
  state: z.string(),
  siteType: z.string(),
  port: z.number(),
  url: z.string(),
  gitUrl: z.string(),
});
const workspaceSchema = z.object({
  path: z.string(),
  branch: z.string(),
  head: z.string(),
  dirty: z.boolean(),
  changes: z.array(z.string()),
  remote: z.string(),
  pushRemote: z.string(),
});
const validationIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  path: z.string().optional(),
});
const validationSchema = z.object({
  valid: z.boolean(),
  contractVersion: z.string(),
  siteType: z.string(),
  checks: z.object({
    files: z.boolean(),
    package: z.boolean(),
    syntax: z.boolean(),
    startup: z.boolean(),
    http: z.boolean(),
  }),
  issues: z.array(validationIssueSchema),
});
const localTestBaseSchema = z.object({
  testedHead: z.string(),
  source: z.literal("working-tree"),
  validation: validationSchema,
});
const localTestSchema = z.discriminatedUnion("running", [
  localTestBaseSchema.extend({ running: z.literal(true), url: z.string().url() }),
  localTestBaseSchema.extend({ running: z.literal(false) }),
]);

export function buildServer(
  auth: AuthClient,
  api: InternAPI,
  workspaces: WorkspaceManager,
): McpServer {
  const server = new McpServer({
    name: "intern",
    version: "0.1.0",
    description: "Work on Intern-hosted sites in guarded local Git checkouts",
  });

  server.registerTool(
    "intern_auth_status",
    {
      description:
        "Check whether this local MCP is authorized with Intern and return the current user and organization without exposing credentials.",
      outputSchema: z.object({
        authorized: z.boolean(),
        session: sessionSchema.optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      result(
        (await auth.hasCredentials())
          ? { authorized: true, session: await api.session() }
          : { authorized: false },
      ),
  );

  server.registerTool(
    "intern_login",
    {
      description:
        "Start Intern browser authorization. After approval, call intern_complete_login before using site tools.",
      inputSchema: z.object({ openBrowser: z.boolean().default(true) }),
      outputSchema: z.object({
        userCode: z.string(),
        verificationURI: z.string(),
        verificationURIComplete: z.string(),
        expiresAt: z.number(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ openBrowser }) => result(await auth.startLogin(openBrowser)),
  );

  server.registerTool(
    "intern_complete_login",
    {
      description:
        "Finish a pending Intern browser authorization after the user approves it.",
      inputSchema: z.object({
        timeoutSeconds: z.number().int().min(1).max(300).default(120),
      }),
      outputSchema: z.object({ authorized: z.literal(true), session: sessionSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ timeoutSeconds }) => {
      await auth.completeLogin(timeoutSeconds * 1000);
      return result({ authorized: true as const, session: await api.session() });
    },
  );

  server.registerTool(
    "intern_logout",
    {
      description:
        "Remove this profile's local Intern credentials. This does not delete sites or files.",
      outputSchema: z.object({ authorized: z.literal(false) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      await workspaces.stopAllTestsThen(async () => {
        await workspaces.clearSSHCertificate();
        await auth.logout();
      });
      return result({ authorized: false as const });
    },
  );

  server.registerTool(
    "intern_list_sites",
    {
      description: "List sites in the authorized Intern organization.",
      outputSchema: z.object({ sites: z.array(siteSchema) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => result({ sites: await api.listSites() }),
  );

  server.registerTool(
    "intern_prepare_site",
    {
      description:
        "Clone or validate an Intern site's guarded local checkout and return its absolute path. Remote creation occurs only when createIfMissing is true.",
      inputSchema: z.object({
        site: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
        createIfMissing: z.boolean().default(false),
        siteType: z.string().default("vite"),
      }),
      outputSchema: z.object({
        site: siteSchema,
        workspace: workspaceSchema,
        validation: validationSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ site: slug, createIfMissing, siteType }) => {
      const session = await api.session();
      const sites = await api.listSites();
      let site = sites.find((candidate) => candidate.slug === slug);
      if (!site && createIfMissing) site = await api.createSite(slug, siteType);
      if (!site)
        throw new Error(
          `Intern site not found: ${slug}; set createIfMissing only if it should be created`,
        );
      const workspace = await workspaces.prepare(session.org.slug, site);
      const validation = await workspaces.validate(
        session.org.slug,
        site,
        await api.runtimeContract(),
      );
      return result({ site, workspace, validation });
    },
  );

  server.registerTool(
    "intern_site_status",
    {
      description: "Inspect one prepared Intern checkout without changing it.",
      inputSchema: z.object({ site: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/) }),
      outputSchema: z.object({ site: siteSchema, workspace: workspaceSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site: slug }) => {
      const { session, site } = await resolveSite(api, slug);
      return result({
        site,
        workspace: await workspaces.status(session.org.slug, site.slug),
      });
    },
  );

  server.registerTool(
    "intern_validate_site",
    {
      description:
        "Validate the prepared checkout's committed HEAD against Intern's authenticated runtime contract. Checks required and protected files, package support, entrypoint syntax, sandboxed startup, and an HTTP response without changing the checkout. Commit model edits first; dirty changes are reported in workspace status but are not part of validation.",
      inputSchema: z.object({ site: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/) }),
      outputSchema: z.object({
        site: siteSchema,
        workspace: workspaceSchema,
        validation: validationSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ site: slug }) => {
      const { session, site } = await resolveSite(api, slug);
      const workspace = await workspaces.status(session.org.slug, site.slug);
      const validation = await workspaces.validate(
        session.org.slug,
        site,
        await api.runtimeContract(),
      );
      return result({ site, workspace, validation });
    },
  );

  server.registerTool(
    "intern_test_site",
    {
      description:
        "Validate the current working tree, replace any prior preview for this site, and serve a temporary snapshot at a loopback HTTP URL. This includes uncommitted tracked and untracked files but excludes ignored files; call it again after edits to refresh the snapshot.",
      inputSchema: z.object({ site: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/) }),
      outputSchema: z.object({
        site: siteSchema,
        workspace: workspaceSchema,
        test: localTestSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ site: slug }) => {
      return workspaces.withTestLifecycle(slug, async () => {
        const { session, site } = await resolveSite(api, slug);
        const tested = await workspaces.testWorkingTree(
          session.org.slug,
          site,
          await api.runtimeContract(),
        );
        return result({ site, ...tested });
      });
    },
  );

  server.registerTool(
    "intern_stop_test",
    {
      description:
        "Stop and remove this site's local loopback test snapshot without contacting Intern. It works after logout or during a backend outage and never changes the Git checkout.",
      inputSchema: z.object({ site: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/) }),
      outputSchema: z.object({ site: z.string(), stopped: z.boolean() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ site: slug }) => {
      return result({ site: slug, stopped: await workspaces.stopTestBySlug(slug) });
    },
  );

  server.registerTool(
    "intern_publish_site",
    {
      description:
        "Validate and push the clean, committed HEAD of a prepared Intern checkout. Refuses runtime-incompatible changes, dirty trees, detached HEADs, unexpected remotes, and non-fast-forward pushes.",
      inputSchema: z.object({ site: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/) }),
      outputSchema: z.object({
        site: siteSchema,
        workspace: workspaceSchema,
        validation: validationSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ site: slug }) => {
      const { session, site } = await resolveSite(api, slug);
      const published = await workspaces.publish(
        session.org.slug,
        site,
        await api.runtimeContract(),
      );
      return result({ site, ...published });
    },
  );

  server.registerResource(
    "intern-session",
    "intern://session",
    {
      title: "Intern authorization session",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, await api.session()),
  );

  server.registerResource(
    "intern-sites",
    "intern://sites",
    {
      title: "Intern sites",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, { sites: await api.listSites() }),
  );

  server.registerResource(
    "intern-workspace",
    new ResourceTemplate("intern://sites/{slug}/workspace", {
      list: async () => ({
        resources: (await api.listSites()).map((site) => ({
          uri: `intern://sites/${site.slug}/workspace`,
          name: `${site.slug} workspace`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Intern site workspace",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const slug = variables.slug;
      if (typeof slug !== "string")
        throw new Error("workspace resource requires one site slug");
      const { session, site } = await resolveSite(api, slug);
      return jsonResource(uri, {
        site,
        workspace: await workspaces.status(session.org.slug, slug),
      });
    },
  );

  return server;
}

async function resolveSite(api: InternAPI, slug: string) {
  const [session, sites] = await Promise.all([api.session(), api.listSites()]);
  const site = sites.find((candidate) => candidate.slug === slug);
  if (!site) throw new Error(`Intern site not found: ${slug}`);
  return { session, site };
}

function result<T extends object>(value: T) {
  const structuredContent = value as unknown as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

function jsonResource(uri: URL, value: object) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
