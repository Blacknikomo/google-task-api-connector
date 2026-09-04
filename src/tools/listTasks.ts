import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, type ToolDeps } from "./index.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export function registerListTasks(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_tasks",
    {
      title: "List open tasks",
      description: "Return open (not completed) tasks in a list, optionally filtered by due date. Omit listId to use the default list.",
      inputSchema: {
        listId: z.string().optional().describe("Task list id from list_task_lists. Default: the user's default list"),
        dueAfter: isoDate.optional().describe("Only tasks due on/after this date"),
        dueBefore: isoDate.optional().describe("Only tasks due on/before this date"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ listId, dueAfter, dueBefore }) => {
      const id = listId ?? (await deps.google.defaultListId());
      const tasks = await deps.google.listOpenTasks(id, { dueMin: dueAfter, dueMax: dueBefore });
      return ok({ listId: id, tasks }, `${tasks.length} open task(s)`);
    },
  );
}
