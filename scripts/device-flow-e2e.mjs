import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const frontend = required("INTERN_BASE_URL");
const publicOrigin = required("INTERN_PUBLIC_ORIGIN");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-device-e2e-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/index.js"), "serve"],
  env: {
    ...process.env,
    INTERN_CONFIG_ROOT: path.join(root, "config"),
    INTERN_WORKSPACE_ROOT: path.join(root, "workspaces"),
  },
});
const client = new Client({ name: "intern-device-e2e", version: "1.0.0" });

try {
  await client.connect(transport);

  // Start authorization through the real local MCP stdio process.
  const started = await client.callTool({
    name: "intern_login",
    arguments: { openBrowser: false },
  });
  const instructions = started.structuredContent;
  assert.equal(instructions.verificationURI, `${publicOrigin}/device`);
  assert.equal(
    instructions.verificationURIComplete,
    `${publicOrigin}/device?code=${encodeURIComponent(instructions.userCode)}`,
  );
  assert.doesNotMatch(
    instructions.verificationURIComplete,
    /client_id|api_key|user_code/,
  );

  // Cross the signed-out browser boundary and preserve the generated code.
  const signedOut = await fetch(instructions.verificationURIComplete, {
    redirect: "manual",
  });
  assert.equal(signedOut.status, 307);
  const loginLocation = signedOut.headers.get("location") ?? "";
  const loginURL = new URL(loginLocation, frontend);
  assert.equal(loginURL.pathname, "/login");
  assert.equal(
    loginURL.searchParams.get("returnTo"),
    `/device?code=${instructions.userCode}`,
  );

  // Establish a real TryIntern session, return to the same code, and POST approval.
  const login = await fetch(`${frontend}/api/dev/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: frontend },
    body: JSON.stringify({
      email: required("INTERN_E2E_ADMIN_EMAIL"),
      password: required("INTERN_E2E_ADMIN_PASSWORD"),
    }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie, "TryIntern login did not set its encrypted session cookie");

  const approvalPage = await fetch(
    `${frontend}/device?code=${encodeURIComponent(instructions.userCode)}`,
    {
      headers: { cookie },
    },
  );
  const approvalHTML = await approvalPage.text();
  const approvalText = approvalHTML.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  assert.equal(approvalPage.status, 200);
  assert.match(approvalText, /Connect Intern Local MCP/);
  assert.match(approvalText, /View your TryIntern identity and organization/);
  assert.match(approvalText, new RegExp(instructions.userCode));

  const approval = await fetch(`${frontend}/device/decision`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin: frontend,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code: instructions.userCode,
      decision: "approve",
    }),
  });
  assert.equal(approval.status, 303);
  assert.match(approval.headers.get("location") ?? "", /\/device\?result=approved$/);

  // Poll the real platform token endpoint, then cross TryIntern HTTP and control gRPC.
  const completed = await client.callTool({
    name: "intern_complete_login",
    arguments: { timeoutSeconds: 30 },
  });
  assert.equal(completed.isError, undefined, JSON.stringify(completed));
  const authorized = completed.structuredContent;
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.session.user.id, required("INTERN_E2E_ADMIN_USER_ID"));
  assert.equal(authorized.session.user.org, required("INTERN_E2E_ADMIN_ORG_ID"));
  assert.equal(authorized.session.org.slug, "local");
} finally {
  await client.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
