import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, type ToolDeps } from "./index.js";
import { findSimilarTasks } from "./findTasks.js";

export function registerCreateTask(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a new Google Task. Call find_tasks first. If a similar open task already exists, this tool will NOT create anything and will return the existing task(s) instead — show them to the user and ask whether to create anyway; if they confirm, call again with force=true. Tasks with a due date also appear in Google Calendar.",
      inputSchema: {
        title: z.string().min(1).max(1024),
        notes: z.string().max(8192).optional(),
        due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional().describe("Due date (date only, no time)"),
        listId: z.string().optional().describe("Default: the user's default list"),
        force: z.boolean().default(false).describe("Create even if a similar task exists"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ title, notes, due, listId, force }) => {
      const targetList = listId ?? (await deps.google.defaultListId());

      if (!force) {
        const dupes = await findSimilarTasks(deps, title, targetList, deps.cfg.duplicateThreshold);
        if (dupes.length > 0) {
          return ok(
            { created: false, reason: "possible_duplicate", candidates: dupes },
            "Not created: similar open task(s) already exist. Ask the user; retry with force=true to create anyway.",
          );
        }
      }

      const task = await deps.google.createTask({ listId: targetList, title, notes, due });
      return ok({ created: true, task }, `Created "${task.title}"${due ? ` due ${due}` : ""}`);
    },
  );
}
