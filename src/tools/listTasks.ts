import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, type ToolDeps } from "./index.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export function registerListTasks(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "Return tasks in a list, optionally filtered by due date. By default only open (not completed) tasks are returned; " +
        "set status to 'completed' to see what has been finished, or 'all' for both. Omit listId to use the default list. " +
        "Use completedAfter/completedBefore to ask what was finished in a period — a list can hold years of completed tasks.",
      inputSchema: {
        listId: z.string().optional().describe("Task list id from list_task_lists. Default: the user's default list"),
        status: z
          .enum(["open", "completed", "all"])
          .default("open")
          .describe("Which tasks to return. Default: open"),
        dueAfter: isoDate.optional().describe("Only tasks due on/after this date"),
        dueBefore: isoDate.optional().describe("Only tasks due on/before this date"),
        completedAfter: isoDate.optional().describe("Only tasks completed on/after this date"),
        completedBefore: isoDate.optional().describe("Only tasks completed on/before this date"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ listId, status, dueAfter, dueBefore, completedAfter, completedBefore }) => {
      const id = listId ?? (await deps.google.defaultListId());
      const { tasks, truncated } = await deps.google.listTasks(id, {
        status,
        dueMin: dueAfter,
        dueMax: dueBefore,
        completedMin: completedAfter,
        completedMax: completedBefore,
      });

      const label = status === "open" ? "open" : status === "completed" ? "completed" : "";
      const summary =
        `${tasks.length} ${label} task(s)`.replace("  ", " ") +
        (truncated ? " (truncated: the list has more tasks than could be fetched; narrow the date range)" : "");

      return ok({ listId: id, status, tasks, ...(truncated ? { truncated: true } : {}) }, summary);
    },
  );
}
