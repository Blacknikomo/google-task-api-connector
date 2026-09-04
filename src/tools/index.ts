/**
 * v1 tool surface (ADR 0009). Each tool is registered on a per-request McpServer instance
 * with the caller's AuthContext bound (stateless transport, ADR 0008).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthContext } from "../types.js";
import type { Config } from "../config.js";
import { GoogleTasksClient } from "../google/client.js";
import { registerListTaskLists } from "./listTaskLists.js";
import { registerListTasks } from "./listTasks.js";
import { registerFindTasks } from "./findTasks.js";
import { registerCreateTask } from "./createTask.js";
import { registerCompleteTask } from "./completeTask.js";

export interface ToolDeps {
  cfg: Config;
  auth: AuthContext;
  google: GoogleTasksClient;
}

export function registerTools(server: McpServer, cfg: Config, auth: AuthContext): void {
  const deps: ToolDeps = { cfg, auth, google: new GoogleTasksClient(auth.googleAccessToken) };
  registerListTaskLists(server, deps);
  registerListTasks(server, deps);
  registerFindTasks(server, deps);
  registerCreateTask(server, deps);
  registerCompleteTask(server, deps);
}

/** Helper: uniform text+JSON result shape. */
export function ok(payload: unknown, summary?: string) {
  return {
    content: [{ type: "text" as const, text: summary ? `${summary}\n\n${JSON.stringify(payload, null, 2)}` : JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

export function fail(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}
