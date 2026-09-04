/** create_task must never silently create a duplicate (ADR 0010). */
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCreateTask } from "../src/tools/createTask.js";
import type { GoogleTasksClient } from "../src/google/client.js";
import type { ToolDeps } from "../src/tools/index.js";
import type { Config } from "../src/config.js";
import type { Task } from "../src/types.js";

type Handler = (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown> }>;

const cfg = { duplicateThreshold: 0.8 } as Config;

function task(title: string, id = "t1"): Task {
  return { id, listId: "list-1", title, status: "needsAction", updated: "" };
}

/** Register the tool against a stub server and hand back its handler. */
function buildTool(existing: Task[]) {
  const createTask = vi.fn(async (t: { title: string }) => task(t.title, "new"));
  const google = {
    defaultListId: async () => "list-1",
    listTaskLists: async () => [{ id: "list-1", title: "My Tasks", updated: "" }],
    listOpenTasks: async () => existing,
    createTask,
  } as unknown as GoogleTasksClient;

  let handler: Handler | undefined;
  const server = {
    registerTool: (_name: string, _meta: unknown, h: Handler) => {
      handler = h;
    },
  } as unknown as McpServer;

  registerCreateTask(server, { cfg, auth: { email: "o@e.com", googleAccessToken: "t" }, google } as ToolDeps);
  return { handler: handler!, createTask };
}

describe("create_task duplicate guard", () => {
  it("refuses to create when a similar open task exists", async () => {
    const { handler, createTask } = buildTool([task("Call the dentist")]);
    const res = await handler({ title: "call dentist", force: false });

    expect(createTask).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ created: false, reason: "possible_duplicate" });
    expect((res.structuredContent!.candidates as unknown[]).length).toBeGreaterThan(0);
  });

  it("creates when nothing similar exists", async () => {
    const { handler, createTask } = buildTool([task("Renew passport")]);
    const res = await handler({ title: "Buy milk", force: false });

    expect(createTask).toHaveBeenCalledOnce();
    expect(res.structuredContent).toMatchObject({ created: true });
  });

  it("creates anyway when force is set", async () => {
    const { handler, createTask } = buildTool([task("Call the dentist")]);
    const res = await handler({ title: "call dentist", force: true });

    expect(createTask).toHaveBeenCalledOnce();
    expect(res.structuredContent).toMatchObject({ created: true });
  });
});
