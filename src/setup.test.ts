import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternSession } from "./api.js";
import {
  parseSetupOptions,
  promptAccessToken,
  readStoredAccessToken,
  runSetup,
} from "./setup.js";

let root: string;
let config: {
  internBaseURL: string;
  workspaceRoot: string;
  configRoot: string;
};
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "intern-setup-test-"));
  config = {
    internBaseURL: "https://tryintern.dev",
    workspaceRoot: path.join(root, "sites"),
    configRoot: path.join(root, "config"),
  };
  env = {
    HOME: root,
    CODEX_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    INTERN_WORKSPACE_ROOT: "/tmp/Intern",
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const session: InternSession = {
  user: {
    id: "usr_1",
    org: "org_1",
    org_name: "Acme",
    org_role: "admin",
  },
  org: { id: "intorg_1", slug: "acme", state: "active" },
};

describe("Intern MCP setup", () => {
  it("validates the token, stores it privately, then configures Codex", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const validate = vi.fn(async () => session);
    const output: string[] = [];
    await runSetup(config, "codex", {
      token: "secret-token",
      packageSpec: "/tmp/intern-mcp.tgz",
      env,
      session: validate,
      run: async (command, args) => {
        calls.push({ command, args });
        return {
          status: 0,
          stdout: args.includes("get")
            ? '{"command": "npx", "args": ["intern-mcp", "launch"]}'
            : "ok",
        };
      },
      write: (message) => output.push(message),
    });

    expect(validate).toHaveBeenCalledWith("secret-token");
    await expect(readStoredAccessToken(config)).resolves.toBe("secret-token");
    expect(
      (await fs.stat(path.join(config.configRoot, "access-token"))).mode & 0o777,
    ).toBe(0o600);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: "codex",
      args: expect.arrayContaining([
        "add",
        "INTERN_WORKSPACE_ROOT=/tmp/Intern",
        "--prefer-online",
        "--package=/tmp/intern-mcp.tgz",
        "launch",
      ]),
    });
    expect(calls[0].args.join(" ")).not.toContain("secret-token");
    expect(calls[1]).toEqual({
      command: "codex",
      args: ["mcp", "get", "intern", "--json"],
    });
    expect(output.join("")).toContain("Intern connected to Codex as Acme · admin");
    expect(output.join("")).not.toContain("secret-token");
  });

  it("saves a launcher that refreshes the latest stable package", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await runSetup(config, "codex", {
      token: "secret-token",
      env,
      registry: "https://registry.npmjs.org",
      session: async () => session,
      run: async (command, args) => {
        calls.push({ command, args });
        return {
          status: 0,
          stdout: args.includes("get")
            ? '{"command": "npx", "args": ["intern-mcp", "launch"]}'
            : "ok",
        };
      },
      write: () => {},
    });

    expect(calls[0]).toMatchObject({
      command: "codex",
      args: expect.arrayContaining([
        "--prefer-online",
        "--@archastro:registry=https://registry.npmjs.org",
        "--package=@archastro/intern-mcp@latest",
        "intern-mcp",
        "launch",
      ]),
    });
  });

  it("replaces only Claude's user-scoped Intern entry", async () => {
    const calls: string[][] = [];
    await runSetup(config, "claude", {
      token: "secret-token",
      env,
      session: async () => session,
      run: async (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stdout: args.includes("get")
            ? "Scope: User config\nStatus: ✓ Connected\nCommand: npx\nArgs: intern-mcp launch"
            : "ok",
        };
      },
      write: () => {},
    });

    expect(calls[0]).toEqual(["claude", "mcp", "remove", "--scope", "user", "intern"]);
    expect(calls[1]).toEqual(
      expect.arrayContaining(["claude", "add", "--scope", "user", "launch"]),
    );
    expect(calls[1].join(" ")).not.toContain("secret-token");
    expect(calls[2]).toEqual(["claude", "mcp", "get", "intern"]);
  });

  it("rejects a connected Claude entry from a shadowing local scope", async () => {
    await expect(
      runSetup(config, "claude", {
        token: "secret-token",
        env,
        session: async () => session,
        run: async (_command, args) => ({
          status: 0,
          stdout: args.includes("get")
            ? "Scope: Local config\nStatus: ✓ Connected\nCommand: npx\nArgs: Scope: User intern-mcp launch"
            : "ok",
        }),
      }),
    ).rejects.toThrow("remove any local/project intern entry");
  });

  it("keeps the new token when Codex commits but readback verification fails", async () => {
    await expect(
      runSetup(config, "codex", {
        token: "new-token",
        env,
        session: async () => session,
        run: async (_command, args) => ({
          status: args.includes("get") ? 1 : 0,
          stdout: "",
        }),
      }),
    ).rejects.toThrow("new profile was retained");
    await expect(readStoredAccessToken(config)).resolves.toBe("new-token");
  });

  it("restores the prior token and host config when replacement fails", async () => {
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.writeFile(path.join(config.configRoot, "access-token"), "old-token\n", {
      mode: 0o600,
    });
    await fs.mkdir(env.CLAUDE_CONFIG_DIR!, { recursive: true });
    const configFile = path.join(env.CLAUDE_CONFIG_DIR!, ".claude.json");
    const previous = '{"mcpServers":{"intern":{"command":"old"}}}\n';
    await fs.writeFile(configFile, previous, { mode: 0o600 });

    await expect(
      runSetup(config, "claude", {
        token: "new-token",
        env,
        session: async () => session,
        run: async (_command, args) => {
          if (args.includes("remove")) {
            const document = JSON.parse(await fs.readFile(configFile, "utf8"));
            delete document.mcpServers.intern;
            await fs.writeFile(configFile, `${JSON.stringify(document)}\n`);
          }
          return { status: args.includes("add") ? 1 : 0, stdout: "" };
        },
      }),
    ).rejects.toThrow("Could not configure Claude Code");

    await expect(readStoredAccessToken(config)).resolves.toBe("old-token");
    expect(JSON.parse(await fs.readFile(configFile, "utf8"))).toEqual(
      JSON.parse(previous),
    );
  });

  it("fails without changing host config when token validation fails", async () => {
    const run = vi.fn();
    await expect(
      runSetup(config, "codex", {
        token: "rejected-token",
        env,
        session: async () => {
          throw new Error("AUTH_REQUIRED: invalid_token");
        },
        run,
      }),
    ).rejects.toThrow("AUTH_REQUIRED");
    expect(run).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(config.configRoot, "access-token")),
    ).rejects.toThrow();
  });

  it("refuses a parallel setup before changing the stored token", async () => {
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.writeFile(path.join(config.configRoot, "setup.lock"), `${process.pid}\n`);

    await expect(
      runSetup(config, "codex", {
        token: "new-token",
        env,
        session: async () => session,
        run: vi.fn(),
      }),
    ).rejects.toThrow("Another Intern setup is already running");
    await expect(
      fs.stat(path.join(config.configRoot, "access-token")),
    ).rejects.toThrow();
  });

  it("fails closed on a stale setup lock", async () => {
    await fs.mkdir(config.configRoot, { recursive: true });
    await fs.writeFile(path.join(config.configRoot, "setup.lock"), "99999999\n");

    await expect(
      runSetup(config, "codex", {
        token: "new-token",
        env,
        session: async () => session,
        run: vi.fn(),
      }),
    ).rejects.toThrow("stale Intern setup lock");
    await expect(
      fs.readFile(path.join(config.configRoot, "setup.lock"), "utf8"),
    ).resolves.toBe("99999999\n");
  });

  it("accepts supported hosts and opt-in verbose diagnostics", () => {
    expect(parseSetupOptions(["--host", "codex"])).toEqual({
      host: "codex",
      verbose: false,
    });
    expect(parseSetupOptions(["--verbose", "--host=claude"])).toEqual({
      host: "claude",
      verbose: true,
    });
    expect(
      parseSetupOptions(["--host=codex", "--registry", "https://registry.npmjs.org/"]),
    ).toEqual({
      host: "codex",
      verbose: false,
      registry: "https://registry.npmjs.org",
    });
    expect(parseSetupOptions(["--host", "cursor"])).toEqual({
      host: "cursor",
      verbose: false,
    });
    expect(parseSetupOptions(["--host", "grok"])).toEqual({
      host: "grok",
      verbose: false,
    });
    expect(() => parseSetupOptions(["--host", "windsurf"])).toThrow("Usage:");
    expect(() => parseSetupOptions(["--host", "codex", "--debug"])).toThrow("Usage:");
    expect(() =>
      parseSetupOptions([
        "--host",
        "codex",
        "--registry=https://user:secret@example.com",
      ]),
    ).toThrow("Usage:");
  });

  it("reads a piped token without echoing it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let visible = "";
    output.on("data", (chunk) => (visible += chunk.toString()));
    input.end("secret-token\n");

    await expect(promptAccessToken(input, output)).resolves.toBe("secret-token");
    expect(visible).toContain("Paste Intern access token");
    expect(visible).not.toContain("secret-token");
  });

  it("renders one asterisk per pasted token character on a terminal", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    output.isTTY = true;
    let visible = "";
    output.on("data", (chunk) => (visible += chunk.toString()));
    input.end("secret-token\n");

    await expect(promptAccessToken(input, output)).resolves.toBe("secret-token");
    expect(visible).toContain("*".repeat("secret-token".length));
    expect(visible).not.toContain("secret-token");
  });

  it("writes Cursor, OpenCode, Rovo Dev, and Pi config without embedding the token", async () => {
    const run = vi.fn();
    for (const host of ["cursor", "opencode", "rovodev", "pi"] as const) {
      await runSetup(config, host, {
        token: "secret-token",
        packageSpec: "/tmp/intern-mcp.tgz",
        env,
        session: async () => session,
        run,
        write: () => {},
      });
    }
    expect(run).not.toHaveBeenCalled();

    const cursor = JSON.parse(
      await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
    );
    expect(cursor.mcpServers.intern).toMatchObject({
      type: "stdio",
      command: "npx",
    });
    expect(cursor.mcpServers.intern.args).toEqual(
      expect.arrayContaining(["intern-mcp", "launch", "--package=/tmp/intern-mcp.tgz"]),
    );
    expect(JSON.stringify(cursor)).not.toContain("secret-token");

    const opencode = JSON.parse(
      await fs.readFile(
        path.join(root, ".config", "opencode", "opencode.json"),
        "utf8",
      ),
    );
    expect(opencode.mcp.intern.command).toEqual(
      expect.arrayContaining(["npx", "intern-mcp", "launch"]),
    );
    expect(opencode.mcp.intern.enabled).toBe(true);

    const rovodev = JSON.parse(
      await fs.readFile(path.join(root, ".rovodev", "mcp.json"), "utf8"),
    );
    expect(rovodev.mcpServers.intern.transport).toBe("stdio");
    expect(rovodev.mcpServers.intern.args).toContain("launch");

    const pi = JSON.parse(
      await fs.readFile(path.join(root, ".config", "mcp", "mcp.json"), "utf8"),
    );
    expect(pi.mcpServers.intern.command).toBe("npx");
    expect(pi.mcpServers.intern.args).toContain("intern-mcp");
  });

  it("tells Pi users to install the MCP adapter", async () => {
    const output: string[] = [];
    await runSetup(config, "pi", {
      token: "secret-token",
      env,
      session: async () => session,
      write: (message) => output.push(message),
    });
    expect(output.join("")).toContain("pi install npm:pi-mcp-adapter");
    expect(output.join("")).toContain("Intern connected to Pi");
  });

  it("registers Grok through grok mcp add without putting the token in argv", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await runSetup(config, "grok", {
      token: "secret-token",
      packageSpec: "/tmp/intern-mcp.tgz",
      env,
      session: async () => session,
      run: async (command, args) => {
        calls.push({ command, args });
        return {
          status: 0,
          stdout: JSON.stringify({
            intern: { command: "npx", args: ["intern-mcp", "launch"] },
          }),
        };
      },
      write: () => {},
    });
    expect(calls[0]).toMatchObject({
      command: "grok",
      args: expect.arrayContaining(["mcp", "add", "intern", "-s", "user", "launch"]),
    });
    expect(calls[0].args.join(" ")).not.toContain("secret-token");
    expect(calls[1]).toEqual({
      command: "grok",
      args: ["mcp", "list", "--json"],
    });
  });

  it("masks a bracketed terminal paste as one asterisk per character", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    output.isTTY = true;
    let visible = "";
    output.on("data", (chunk) => (visible += chunk.toString()));
    const token = "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9";
    const escape = String.fromCharCode(27);
    const pending = promptAccessToken(input, output);
    input.write(`${escape}[200~${token}${escape}[201~\n`);
    await expect(pending).resolves.toBe(token);
    expect(visible).toContain("*".repeat(token.length));
    expect(visible).not.toContain("eyJ");
    expect(visible).not.toContain("[200~");
  });

  it("paints one asterisk per character when a token is pasted in one chunk", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    output.isTTY = true;
    let visible = "";
    output.on("data", (chunk) => (visible += chunk.toString()));
    const pending = promptAccessToken(input, output);
    input.write("eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9");
    input.write("\n");
    await expect(pending).resolves.toBe("eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9");
    expect(visible).toContain(
      "*".repeat("eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9".length),
    );
    expect(visible).not.toContain("eyJ");
  });

  it("rejects terminal cancellation instead of leaving setup pending", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    output.isTTY = true;

    const pending = promptAccessToken(input, output);
    input.write(String.fromCharCode(3));

    await expect(pending).rejects.toThrow("Token entry cancelled");
  });
});
