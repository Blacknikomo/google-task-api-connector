import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, type ToolDeps } from "./index.js";
import { similarity } from "./similarity.js";
import type { TaskMatch } from "../types.js";

export function registerFindTasks(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "find_tasks",
    {
      title: "Find tasks by title",
      description:
        "Search open tasks whose title resembles the query, across all lists (or one list). ALWAYS call this before create_task to avoid duplicates. Returns candidates sorted by similarity (0..1).",
      inputSchema: {
        query: z.string().min(1).describe("Task title or keywords to look for"),
        listId: z.string().optional().describe("Restrict to one list; default: all lists"),
        minScore: z.number().min(0).max(1).default(0.3),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, listId, minScore }) => {
      const matches = await findSimilarTasks(deps, query, listId, minScore);
      return ok({ query, matches }, matches.length ? `${matches.length} candidate(s)` : "No similar open tasks found");
    },
  );
}

/** Shared with create_task (ADR 0010). */
export async function findSimilarTasks(deps: ToolDeps, query: string, listId: string | undefined, minScore: number): Promise<TaskMatch[]> {
  const listIds = listId ? [listId] : (await deps.google.listTaskLists()).map((l) => l.id);
  const results: TaskMatch[] = [];
  for (const id of listIds) {
    const tasks = await deps.google.listOpenTasks(id);
    for (const task of tasks) {
      const score = similarity(query, task.title);
      if (score >= minScore) results.push({ task, score });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}
