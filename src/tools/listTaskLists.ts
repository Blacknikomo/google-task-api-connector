import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, type ToolDeps } from "./index.js";

export function registerListTaskLists(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_task_lists",
    {
      title: "List task lists",
      description: "Return the user's Google Tasks lists (id and title). Call this when the user names a specific list or when you need a listId for other tools.",
      inputSchema: {},
      outputSchema: { lists: z.array(z.object({ id: z.string(), title: z.string() })) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const lists = await deps.google.listTaskLists();
      return ok({ lists: lists.map(({ id, title }) => ({ id, title })) });
    },
  );
}
