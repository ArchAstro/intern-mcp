import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export const DEFAULT_INTERN_BASE_URL = "https://tryintern.dev";

export interface InternConfig {
  internBaseURL: string;
  workspaceRoot: string;
  configRoot: string;
  gitSSHCommand?: string;
  iapIDToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): InternConfig {
  return {
    internBaseURL: cleanURL(env.INTERN_BASE_URL ?? DEFAULT_INTERN_BASE_URL),
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
