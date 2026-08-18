const SETUP_URL = "https://tryintern.dev/connect";

export class AuthClient {
  constructor(private readonly token = process.env.INTERN_ACCESS_TOKEN) {}

  async accessToken(): Promise<string> {
    const token = this.token?.trim();
    if (!token) {
      throw new Error(
        `AUTH_REQUIRED: create a profile access token at ${SETUP_URL}, add it to this MCP server as INTERN_ACCESS_TOKEN, then restart the MCP host`,
      );
    }
    return token;
  }

  async hasCredentials(): Promise<boolean> {
    return Boolean(this.token?.trim());
  }
}
