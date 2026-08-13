import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export const DEFAULT_INTERN_BASE_URL = "https://tryintern.dev";
export const DEFAULT_ARCHASTRO_API_URL = "https://platform.archastro.ai";
export const DEFAULT_ARCHASTRO_PUBLISHABLE_KEY =
  "pk_dap_0344yXHSZ9tsm9NOpMQ6Y3_vGwdlFjMxYdiN0jtVN3wcsZ3krjKk_S4";
export const DEFAULT_INTERN_OAUTH_CLIENT_ID = "cc_vuMmqN4VbAKy8zsWRYorUg";

export interface InternConfig {
  internBaseURL: string;
  archAstroBaseURL: string;
  publishableKey?: string;
  oauthClientID?: string;
  workspaceRoot: string;
  configRoot: string;
  gitSSHCommand?: string;
  iapIDToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): InternConfig {
  return {
    internBaseURL: cleanURL(env.INTERN_BASE_URL ?? DEFAULT_INTERN_BASE_URL),
    archAstroBaseURL: cleanURL(env.ARCHASTRO_API_URL ?? DEFAULT_ARCHASTRO_API_URL),
    publishableKey: env.ARCHASTRO_PUBLISHABLE_KEY ?? DEFAULT_ARCHASTRO_PUBLISHABLE_KEY,
    oauthClientID: env.INTERN_OAUTH_CLIENT_ID ?? DEFAULT_INTERN_OAUTH_CLIENT_ID,
    workspaceRoot: path.resolve(
      env.INTERN_WORKSPACE_ROOT ?? path.join(os.homedir(), "Intern"),
    ),
    configRoot: path.resolve(
      env.INTERN_CONFIG_ROOT ?? path.join(os.homedir(), ".config", "intern"),
    ),
    gitSSHCommand: env.INTERN_GIT_SSH_COMMAND,
    iapIDToken: env.INTERN_IAP_ID_TOKEN ?? env.IAP_ID_TOKEN,
  };
}

function cleanURL(value: string): string {
  return value.replace(/\/+$/, "");
}
