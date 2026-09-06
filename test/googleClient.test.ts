/** GoogleTasksClient: pagination, date widening and error mapping against a stubbed Tasks API. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleApiError, GoogleTasksClient } from "../src/google/client.js";

const BASE = "https://tasks.googleapis.com/tasks/v1";

function stub(routes: (url: URL, init?: RequestInit) => Response) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => routes(new URL(String(input)), init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("GoogleTasksClient", () => {
  it("follows nextPageToken until the last page", async () => {
    const mock = stub((url) => {
      const token = url.searchParams.get("pageToken");
      if (!token) return json({ items: [{ id: "1", title: "one" }], nextPageToken: "p2" });
      return json({ items: [{ id: "2", title: "two" }] });
    });

    const lists = await new GoogleTasksClient("tok").listTaskLists();
    expect(lists.map((l) => l.id)).toEqual(["1", "2"]);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("matches a task due exactly on the queried day", async () => {
    // Regression: this was delegated to Google's dueMin/dueMax. A task due on the same day sits
    // exactly on the dueMin boundary, whose inclusivity Google does not document, so a
    // single-day query could come back empty even though the task exists.
    stub(() =>
      json({
        items: [
          { id: "today", title: "due today", status: "needsAction", due: "2026-09-05T00:00:00.000Z" },
          { id: "yesterday", title: "due yesterday", status: "needsAction", due: "2026-09-04T00:00:00.000Z" },
          { id: "tomorrow", title: "due tomorrow", status: "needsAction", due: "2026-09-06T00:00:00.000Z" },
          { id: "nodate", title: "no due date", status: "needsAction" },
          { id: "done", title: "done today", status: "completed", due: "2026-09-05T00:00:00.000Z" },
        ],
      }),
    );

    const tasks = await new GoogleTasksClient("tok").listOpenTasks("list-1", {
      dueMin: "2026-09-05",
      dueMax: "2026-09-05",
    });
    expect(tasks.map((t) => t.id)).toEqual(["today"]);
  });

  it("does not filter by date when no range is given, and keeps undated tasks", async () => {
    stub(() =>
      json({
        items: [
          { id: "1", title: "dated", status: "needsAction", due: "2026-01-01T00:00:00.000Z" },
          { id: "2", title: "undated", status: "needsAction" },
          { id: "3", title: "done", status: "completed" },
        ],
      }),
    );
    const tasks = await new GoogleTasksClient("tok").listOpenTasks("list-1");
    expect(tasks.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("treats an open-ended range as inclusive on the given side", async () => {
    const items = [
      { id: "a", title: "a", status: "needsAction", due: "2026-09-04T00:00:00.000Z" },
      { id: "b", title: "b", status: "needsAction", due: "2026-09-05T00:00:00.000Z" },
      { id: "c", title: "c", status: "needsAction", due: "2026-09-06T00:00:00.000Z" },
    ];
    stub(() => json({ items }));
    const client = new GoogleTasksClient("tok");

    expect((await client.listOpenTasks("l", { dueMin: "2026-09-05" })).map((t) => t.id)).toEqual(["b", "c"]);
    expect((await client.listOpenTasks("l", { dueMax: "2026-09-05" })).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("asks Google for hidden tasks when completed ones are wanted", async () => {
    // Tasks ticked off in Google's own apps become hidden, so showCompleted alone returns nothing.
    let seen: URL | undefined;
    stub((url) => {
      seen = url;
      return json({ items: [{ id: "1", title: "done", status: "completed", completed: "2026-09-05T09:00:00.000Z" }] });
    });

    const { tasks } = await new GoogleTasksClient("tok").listTasks("list-1", { status: "completed" });
    expect(seen!.searchParams.get("showCompleted")).toBe("true");
    expect(seen!.searchParams.get("showHidden")).toBe("true");
    expect(tasks.map((t) => t.id)).toEqual(["1"]);
  });

  it("separates open, completed and all", async () => {
    const items = [
      { id: "open", title: "open", status: "needsAction" },
      { id: "done", title: "done", status: "completed", completed: "2026-09-05T09:00:00.000Z" },
    ];
    stub(() => json({ items }));
    const client = new GoogleTasksClient("tok");

    expect((await client.listTasks("l", { status: "open" })).tasks.map((t) => t.id)).toEqual(["open"]);
    expect((await client.listTasks("l", { status: "completed" })).tasks.map((t) => t.id)).toEqual(["done"]);
    expect((await client.listTasks("l", { status: "all" })).tasks.map((t) => t.id).sort()).toEqual(["done", "open"]);
  });

  it("filters completed tasks by the day they were completed", async () => {
    stub(() =>
      json({
        items: [
          { id: "today", title: "a", status: "completed", completed: "2026-09-05T23:30:00.000Z" },
          { id: "yesterday", title: "b", status: "completed", completed: "2026-09-04T08:00:00.000Z" },
        ],
      }),
    );

    const { tasks } = await new GoogleTasksClient("tok").listTasks("l", {
      status: "completed",
      completedMin: "2026-09-05",
      completedMax: "2026-09-05",
    });
    expect(tasks.map((t) => t.id)).toEqual(["today"]);
  });

  it("reports truncation instead of silently returning a partial list", async () => {
    // Always hand back another page token so the page cap is what stops it.
    stub(() => json({ items: [{ id: "x", title: "x", status: "needsAction" }], nextPageToken: "more" }));
    const { truncated } = await new GoogleTasksClient("tok").listTasks("l");
    expect(truncated).toBe(true);
  });

  it("asks Google only for open tasks and sets listId on every result", async () => {
    let seen: URL | undefined;
    stub((url) => {
      seen = url;
      return json({ items: [{ id: "1", title: "open", status: "needsAction" }] });
    });
    const tasks = await new GoogleTasksClient("tok").listOpenTasks("list-1");
    expect(seen!.searchParams.get("showCompleted")).toBe("false");
    expect(seen!.searchParams.get("showHidden")).toBe("false");
    expect(tasks[0].listId).toBe("list-1");
  });

  it("sends a date-only due timestamp when creating", async () => {
    let body: unknown;
    stub((_url, init) => {
      body = JSON.parse(String(init?.body));
      return json({ id: "new", title: "Buy milk", due: "2026-09-10T00:00:00.000Z", status: "needsAction" });
    });

    const task = await new GoogleTasksClient("tok").createTask({ listId: "list-1", title: "Buy milk", due: "2026-09-10" });
    expect(body).toMatchObject({ title: "Buy milk", due: "2026-09-10T00:00:00.000Z" });
    expect(task.id).toBe("new");
  });

  it("resolves the default list id", async () => {
    stub((url) => {
      expect(url.pathname).toBe("/tasks/v1/users/@me/lists/@default");
      return json({ id: "real-default-id", title: "My Tasks" });
    });
    expect(await new GoogleTasksClient("tok").defaultListId()).toBe("real-default-id");
  });

  it("escapes list and task ids into the path", async () => {
    let path: string | undefined;
    stub((url) => {
      path = url.pathname;
      return json({ id: "t", title: "x", status: "completed" });
    });
    await new GoogleTasksClient("tok").completeTask("a/b", "c d");
    expect(path).toBe(`/tasks/v1/lists/a%2Fb/tasks/c%20d`);
  });

  it("maps HTTP failures to an actionable GoogleApiError", async () => {
    stub(() => new Response("quota exceeded", { status: 403 }));
    await expect(new GoogleTasksClient("tok").listTaskLists()).rejects.toBeInstanceOf(GoogleApiError);
    await expect(new GoogleTasksClient("tok").listTaskLists()).rejects.toThrow(/403.*missing scope or quota/);
  });

  it("sends the bearer token", async () => {
    let auth: string | undefined;
    stub((_url, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? undefined;
      return json({ items: [] });
    });
    await new GoogleTasksClient("secret-token").listTaskLists();
    expect(auth).toBe("Bearer secret-token");
  });
});
