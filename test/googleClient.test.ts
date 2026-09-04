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

  it("widens due dates to cover the whole day and drops completed tasks", async () => {
    let seen: URL | undefined;
    stub((url) => {
      seen = url;
      return json({
        items: [
          { id: "1", title: "open", status: "needsAction" },
          { id: "2", title: "done", status: "completed" },
        ],
      });
    });

    const tasks = await new GoogleTasksClient("tok").listOpenTasks("list-1", {
      dueMin: "2026-09-01",
      dueMax: "2026-09-30",
    });

    expect(seen!.searchParams.get("dueMin")).toBe("2026-09-01T00:00:00.000Z");
    expect(seen!.searchParams.get("dueMax")).toBe("2026-09-30T23:59:59.999Z");
    expect(seen!.searchParams.get("showCompleted")).toBe("false");
    expect(tasks.map((t) => t.id)).toEqual(["1"]);
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
