/**
 * Builds a per-request McpServer bound to the caller's identity and serves it over
 * stateless Streamable HTTP (ADR 0008).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "../config.js";
import type { AuthContext } from "../types.js";
import { registerTools } from "../tools/index.js";

export const SERVER_INFO = { name: "google-tasks-connector", version: "0.1.0" } as const;

export async function handleMcpRequest(req: Request, cfg: Config, auth: AuthContext): Promise<Response> {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Google Tasks for this user. To add a task: call find_tasks, then create_task. Tasks with a due date show up in Google Calendar automatically.",
  });
  registerTools(server, cfg, auth);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // TODO: confirm whether close() is needed per request in stateless mode with the installed SDK version
    await transport.close().catch(() => undefined);
  }
}
