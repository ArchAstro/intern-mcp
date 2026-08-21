import { completable, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { AuthClient } from "./auth.js";
import {
  InternAPIError,
  type InternAPI,
  type InternSession,
  type InternSite,
} from "./api.js";
import { PACKAGE_VERSION } from "./config.js";
import type { WorkspaceManager } from "./workspace.js";

function siteSlugSchema() {
  return z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/)
    .describe(
      "Intern site slug: a lowercase letter, then lowercase letters, digits, or hyphens",
    );
}

const siteSlug = siteSlugSchema();

const SERVER_INSTRUCTIONS = [
  "Work on Intern-hosted sites in guarded local Git checkouts. Intern never stages or commits files.",
  "Authentication comes from the mode-0600 profile used by intern-mcp launch, or from INTERN_ACCESS_TOKEN in a manual stdio configuration. If it is missing, ask the user to create a profile token at https://tryintern.dev/connect and run the setup command shown there. Never ask the user to paste a token into chat or a tool call.",
  "1. intern_auth_status — confirm the configured token resolves to the expected user and organization.",
  "2. intern_prepare_site — idempotently install the site's me plugin, clone or reuse the checkout, and edit files at the returned absolute path with the host's filesystem tools.",
  "3. intern_test_site — preview the working tree (untracked included, ignored excluded) at a loopback URL. It skips deleted tracked files, upgrades Intern-owned runtime files, installs devDependencies locally, runs the site build script when present, and writes dist/ into the checkout. Call it again after further edits. intern_stop_test stops it.",
  "For current-user features, add @archastro/intern-sdk as a devDependency, default-import Client, construct new Client(), and use client.me. Never write globalThis.intern, a memory adapter, a gateway adapter, or other runtime selection into the checkout. intern_test_site injects the local runtime outside the snapshot; the production host supplies its implementation to the same committed bundle.",
  "4. Commit with the host's git, including dist/ when intern_test_site wrote it, then intern_validate_site against Intern's runtime contract.",
  "5. intern_publish_site — pushes only a clean, committed HEAD that passed validation. The tenant does not install packages or build.",
  "Use intern_list_sites and intern_site_status to inspect. Setup users rotate access by rerunning setup and restarting the host; manual users update INTERN_ACCESS_TOKEN and restart it.",
].join("\n");

const sessionSchema = z.object({
  user: z.object({
    id: z.string(),
    org: z.string(),
    org_name: z.string(),
    org_role: z.enum(["admin", "member", "viewer"]),
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    profile_picture: z
      .object({
        url: z.string().nullable().optional(),
        mime_type: z.string().nullable().optional(),
        width: z.number().nullable().optional(),
        height: z.number().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
  org: z.object({ id: z.string().nullable(), slug: z.string(), state: z.string() }),
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
const prepareResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    site: siteSchema,
    workspace: workspaceSchema,
    validation: validationSchema,
  }),
  z.object({
    status: z.literal("provisioning"),
    orgState: z.string(),
    retryAfterMs: z.number(),
    message: z.string(),
  }),
]);
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
  const server = new McpServer(
    {
      name: "intern",
      version: PACKAGE_VERSION,
      description: "Work on Intern-hosted sites in guarded local Git checkouts",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "intern_auth_status",
    {
      title: "Check Intern authorization",
      description:
        "Check whether this local MCP is authorized with Intern and return the current user and organization without exposing credentials.",
      outputSchema: z.object({
        authorized: z.boolean(),
        session: sessionSchema.optional(),
        setupURL: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      if (!(await auth.hasCredentials())) {
        return result({
          authorized: false,
          setupURL: "https://tryintern.dev/connect",
        });
      }
      try {
        return result({ authorized: true, session: await api.session() });
      } catch (error) {
        if (!isAuthRequired(error)) throw error;
        return result({
          authorized: false,
          setupURL: "https://tryintern.dev/connect",
        });
      }
    },
  );

  server.registerTool(
    "intern_list_sites",
    {
      title: "List Intern sites",
      description: "List sites in the authorized Intern organization.",
      outputSchema: z.object({ sites: z.array(siteSchema) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => result({ sites: await api.listSites() }),
  );

  server.registerTool(
    "intern_prepare_site",
    {
      title: "Prepare Intern checkout",
      description:
        "Idempotently install the Intern site's me plugin, clone or validate its guarded local checkout, resolve and pin the latest public @archastro/intern-sdk development dependency, and return its absolute path. Remote creation occurs only when createIfMissing is true.",
      inputSchema: z.object({
        site: siteSlug,
        createIfMissing: z
          .boolean()
          .default(false)
          .describe("Create the remote Intern site if it does not exist"),
        siteType: z
          .string()
          .default("vite")
          .describe("Runtime site type used only when creating a missing site"),
      }),
      outputSchema: prepareResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ site: slug, createIfMissing, siteType }) => {
      return result(
        await prepareInternSite(api, workspaces, {
          site: slug,
          createIfMissing,
          siteType,
        }),
      );
    },
  );

  server.registerTool(
    "intern_site_status",
    {
      title: "Inspect Intern checkout",
      description: "Inspect one prepared Intern checkout without changing it.",
      inputSchema: z.object({ site: siteSlug }),
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
      title: "Validate Intern commit",
      description:
        "Validate the prepared checkout's committed HEAD against Intern's authenticated runtime contract. Checks required and protected files, package support, a committed dist/ when the site has a build script, entrypoint syntax, sandboxed startup, and an HTTP response without changing the checkout. Commit model edits first, including dist/ written by intern_test_site; dirty changes are reported in workspace status but are not part of validation.",
      inputSchema: z.object({ site: siteSlug }),
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
      const workspace = await workspaces.status(session.org.slug, site.slug);
      const validation = await workspaces.validate(
        session.org.slug,
        site,
        await api.runtimeContract(),
        { requireBuildOutput: true },
      );
      return result({ site, workspace, validation });
    },
  );

  server.registerTool(
    "intern_test_site",
    {
      title: "Preview Intern working tree",
      description:
        "Validate the current working tree, replace any prior preview for this site, and serve a temporary snapshot at a loopback HTTP URL. Includes uncommitted tracked and untracked files, excludes ignored files, and skips tracked files deleted on disk. Installs devDependencies locally, runs the site build script when present, and writes dist/ plus Intern-owned runtime upgrades into the checkout so they can be committed. Call it again after edits to refresh the snapshot.",
      inputSchema: z.object({ site: siteSlug }),
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
          session,
        );
        return result({ site, ...tested });
      });
    },
  );

  server.registerTool(
    "intern_stop_test",
    {
      title: "Stop Intern preview",
      description:
        "Stop and remove this site's local loopback test snapshot without contacting Intern. It works after logout or during a backend outage and never changes the Git checkout.",
      inputSchema: z.object({ site: siteSlug }),
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
      title: "Publish Intern site",
      description:
        "Validate and push the clean, committed HEAD of a prepared Intern checkout. Refuses runtime-incompatible changes, missing committed build output when the site has a build script, dirty trees, detached HEADs, unexpected remotes, and non-fast-forward pushes. The tenant serves the committed tree and does not install or build.",
      inputSchema: z.object({ site: siteSlug }),
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
      description:
        "Current Intern user and organization. Does not include credentials.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, await api.session()),
  );

  server.registerResource(
    "intern-sites",
    "intern://sites",
    {
      title: "Intern sites",
      description: "Sites in the authorized Intern organization.",
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
      complete: {
        slug: (value) => completeSiteSlugs(api, value),
      },
    }),
    {
      title: "Intern site workspace",
      description: "Local Git checkout status for one Intern site.",
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

  server.registerPrompt(
    "intern_work_on_site",
    {
      title: "Work on an Intern site",
      description: "Prepare, preview, validate, and publish one Intern site.",
      argsSchema: z.object({
        site: completable(siteSlugSchema(), (value) => completeSiteSlugs(api, value)),
      }),
    },
    ({ site }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Work on Intern site "${site}".`,
              "1. Call intern_auth_status. If unauthorized, ask the user to create a token at https://tryintern.dev/connect, run the setup command shown there, and restart the MCP host. Manual configurations instead update INTERN_ACCESS_TOKEN. Never ask them to paste the token into chat.",
              `2. Call intern_prepare_site with site "${site}". Edit files at the returned workspace.path using this host's filesystem tools.`,
              "3. Intern never stages or commits files. After edits, call intern_test_site to preview the working tree (untracked included, ignored excluded). It runs the local install and build, writes dist/ into the checkout, and skips deleted tracked files. Call it again after further edits. intern_stop_test stops the preview.",
              "4. Commit with this host's git, including any dist/ intern_test_site wrote, then call intern_validate_site.",
              "5. Call intern_publish_site only when validation is valid and the worktree is clean.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}

export interface ReadinessRuntime {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

const productionReadinessRuntime: ReadinessRuntime = {
  now: Date.now,
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
};

const organizationReadinessTimeoutMs = 20_000;
const organizationReadinessPollMs = 1_000;
const organizationRetryAfterMs = 5_000;

export async function prepareInternSite(
  api: InternAPI,
  workspaces: WorkspaceManager,
  input: { site: string; createIfMissing: boolean; siteType: string },
  runtime: ReadinessRuntime = productionReadinessRuntime,
) {
  const controller = new AbortController();
  const deadlineAt = runtime.now() + organizationReadinessTimeoutMs;
  const deadlineReason = new Error("organization readiness timed out");
  const deadlineTimer = setTimeout(
    () => controller.abort(deadlineReason),
    organizationReadinessTimeoutMs,
  );
  deadlineTimer.unref?.();
  const stopReadiness = () => {
    clearTimeout(deadlineTimer);
    if (!controller.signal.aborted) controller.abort();
  };
  let session: InternSession;
  let site: InternSite | undefined;
  let orgState = "unprovisioned";
  let authoritativeReadinessObserved = false;
  try {
    session = await api.session(controller.signal);
    orgState = session.org.state;
    authoritativeReadinessObserved = organizationProvisioningIsAuthoritative(orgState);
    const sites = await api.listSites(controller.signal);
    site = sites.find((candidate) => candidate.slug === input.site);

    if (session.org.state === "active") {
      stopReadiness();
    } else if (!input.createIfMissing) {
      stopReadiness();
      throw new Error(
        `Intern site not found: ${input.site}; set createIfMissing only if it should be created`,
      );
    } else {
      if (shouldTriggerProvisioning(session.org.state, site)) {
        try {
          site = await api.createSite(input.site, input.siteType, controller.signal);
        } catch (error) {
          if (!(error instanceof InternAPIError) || error.code !== "org_not_ready") {
            throw error;
          }
          orgState = "provisioning";
          authoritativeReadinessObserved = true;
        }
      }
      while (session.org.state !== "active") {
        const remaining = deadlineAt - runtime.now();
        if (remaining <= 0) {
          stopReadiness();
          if (authoritativeReadinessObserved) return provisioningResult(orgState);
          throw deadlineReason;
        }
        await runtime.sleep(
          Math.min(organizationReadinessPollMs, remaining),
          controller.signal,
        );
        if (runtime.now() >= deadlineAt) {
          stopReadiness();
          if (authoritativeReadinessObserved) return provisioningResult(orgState);
          throw deadlineReason;
        }
        session = await api.session(controller.signal);
        if (
          session.org.state !== "active" &&
          !(orgState === "provisioning" && session.org.state === "unprovisioned")
        ) {
          orgState = session.org.state;
        }
        authoritativeReadinessObserved ||= organizationProvisioningIsAuthoritative(
          session.org.state,
        );
      }
      const sitesAfterProvisioning = await api.listSites(controller.signal);
      site = sitesAfterProvisioning.find((candidate) => candidate.slug === input.site);
      stopReadiness();
    }
  } catch (error) {
    clearTimeout(deadlineTimer);
    if (error === deadlineReason && authoritativeReadinessObserved) {
      return provisioningResult(orgState);
    }
    throw error;
  }

  if (!site && input.createIfMissing) {
    site = await api.createSite(input.site, input.siteType);
  }
  if (!site)
    throw new Error(
      `Intern site not found: ${input.site}; set createIfMissing only if it should be created`,
    );
  await api.sitePlugins.put(site.slug, "me", "me");
  const contract = await api.runtimeContract();
  const workspace = await workspaces.prepare(session.org.slug, site, contract);
  const validation = await workspaces.validate(session.org.slug, site, contract);
  return { status: "ready" as const, site, workspace, validation };
}

function shouldTriggerProvisioning(
  state: string,
  existingSite: InternSite | undefined,
): boolean {
  if (state === "failed" || state === "destroyed") return true;
  return state === "unprovisioned" && existingSite === undefined;
}

function organizationProvisioningIsAuthoritative(state: string): boolean {
  return state === "provisioning";
}

function provisioningResult(orgState: string) {
  return {
    status: "provisioning" as const,
    orgState,
    retryAfterMs: organizationRetryAfterMs,
    message:
      "Intern is still preparing your organization. Retry intern_prepare_site shortly.",
  };
}

async function completeSiteSlugs(api: InternAPI, value: string): Promise<string[]> {
  try {
    return (await api.listSites())
      .map((site) => site.slug)
      .filter((slug) => slug.startsWith(value));
  } catch {
    return [];
  }
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

function isAuthRequired(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("AUTH_REQUIRED:");
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
