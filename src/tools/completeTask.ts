import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, type ToolDeps } from "./index.js";

export function registerCompleteTask(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description: "Mark a task as completed. Use find_tasks or list_tasks first to obtain listId and taskId.",
      inputSchema: {
        listId: z.string(),
        taskId: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ listId, taskId }) => {
      const task = await deps.google.completeTask(listId, taskId);
      return ok({ task }, `Completed "${task.title}"`);
    },
  );
}
