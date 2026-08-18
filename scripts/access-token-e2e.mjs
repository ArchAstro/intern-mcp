import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "..");
const expectUnauthorized = process.argv.includes("--expect-unauthorized");
if (!process.env.INTERN_ACCESS_TOKEN) {
  throw new Error("INTERN_ACCESS_TOKEN is required for the live MCP proof");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(packageRoot, "dist/index.js"), "serve"],
  env: process.env,
  stderr: "pipe",
});
const client = new Client({ name: "intern-access-token-proof", version: "1.0.0" });

await client.connect(transport);
try {
  const status = await client.callTool({ name: "intern_auth_status", arguments: {} });
  const authorized = status.structuredContent?.authorized;
  const org = status.structuredContent?.session?.org?.slug;
  if (expectUnauthorized) {
    if (authorized !== false) {
      throw new Error(
        `Intern MCP still accepted the revoked token: ${JSON.stringify(status.structuredContent)}`,
      );
    }
    process.stdout.write(
      "PASS Intern MCP rejected the revoked access token over stdio\n",
    );
    process.exitCode = 0;
  } else {
    if (authorized !== true || typeof org !== "string" || !org) {
      throw new Error(
        `Intern MCP did not authorize the profile token: ${JSON.stringify(status.structuredContent)}`,
      );
    }

    const listed = await client.callTool({ name: "intern_list_sites", arguments: {} });
    if (!Array.isArray(listed.structuredContent?.sites)) {
      throw new Error("Intern MCP did not return a site list");
    }
    process.stdout.write(`PASS Intern MCP access token over stdio for ${org}\n`);
  }
} finally {
  await client.close();
}
