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
    // API Gateway buffers the whole Lambda response, so an SSE stream can never actually stream
    // through it. Ask the transport for a single JSON response instead.
    enableJsonResponse: true,
  });
  await server.connect(transport);

  // Do NOT close before the body is read: closing an in-flight response leaves the client with an
  // empty body. Read it here, then tear down and hand back an equivalent Response.
  const res = await transport.handleRequest(req);
  const body = await res.text();
  await transport.close().catch(() => undefined);
  await server.close().catch(() => undefined);

  return new Response(body || null, { status: res.status, headers: res.headers });
}
