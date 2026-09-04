/**
 * Thin typed wrapper over the Google Tasks REST API v1 (ADR 0004: fetch, not `googleapis`).
 * Docs: https://developers.google.com/tasks/reference/rest
 */
import type { NewTask, Task, TaskList } from "../types.js";

const BASE = "https://tasks.googleapis.com/tasks/v1";
const PAGE_SIZE = 100; // Google's maximum

/** Shape of a task as returned by the API (only the fields we use). */
interface ApiTask {
  id: string;
  title?: string;
  notes?: string;
  status?: string;
  due?: string;
  completed?: string;
  updated?: string;
  parent?: string;
  webViewLink?: string;
}

interface ApiTaskList {
  id: string;
  title?: string;
  updated?: string;
}

interface Page<T> {
  items?: T[];
  nextPageToken?: string;
}

export class GoogleTasksClient {
  constructor(private readonly accessToken: string) {}

  async listTaskLists(): Promise<TaskList[]> {
    const items = await this.paginate<ApiTaskList>("/users/@me/lists", {});
    return items.map((l) => ({ id: l.id, title: l.title ?? "(untitled)", updated: l.updated ?? "" }));
  }

  /** Open (needsAction) tasks in a list. Google returns max 100 per page; paginate. */
  async listOpenTasks(listId: string, opts: { dueMin?: string; dueMax?: string } = {}): Promise<Task[]> {
    // The due-date filter is applied here rather than by Google. `due` only ever holds a date at
    // midnight UTC, so a task due on the same day as dueMin sits exactly ON the boundary, and
    // Google does not document whether dueMin/dueMax are inclusive — a single-day query could
    // silently return nothing. Filtering locally makes "on or after" / "on or before" exact, and
    // costs no extra requests: find_tasks already reads every open task in a list.
    const items = await this.paginate<ApiTask>(`/lists/${encodeURIComponent(listId)}/tasks`, {
      showCompleted: "false",
      showHidden: "false",
    });

    return items
      .filter((t) => t.status !== "completed")
      .map((t) => toTask(t, listId))
      .filter((t) => dueWithin(t.due, opts.dueMin, opts.dueMax));
  }

  async createTask(task: NewTask & { listId: string }): Promise<Task> {
    const body: Record<string, unknown> = { title: task.title };
    if (task.notes) body.notes = task.notes;
    // Google Tasks stores a date only; any time component is ignored and echoed back as 00:00:00Z.
    if (task.due) body.due = `${task.due}T00:00:00.000Z`;

    const created = await this.request<ApiTask>("POST", `/lists/${encodeURIComponent(task.listId)}/tasks`, body);
    return toTask(created, task.listId);
  }

  async completeTask(listId: string, taskId: string): Promise<Task> {
    const updated = await this.request<ApiTask>(
      "PATCH",
      `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { status: "completed" },
    );
    return toTask(updated, listId);
  }

  /** The list Google calls "@default" — resolves to its real id. */
  async defaultListId(): Promise<string> {
    const list = await this.request<ApiTaskList>("GET", "/users/@me/lists/@default");
    return list.id;
  }

  // ---- internals -------------------------------------------------------

  private async paginate<T>(path: string, query: Record<string, string>): Promise<T[]> {
    const all: T[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ ...query, maxResults: String(PAGE_SIZE) });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.request<Page<T>>("GET", `${path}?${params}`);
      all.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return all;
  }

  protected async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new GoogleApiError(res.status, await res.text(), res.headers.get("retry-after") ?? undefined);
    }
    // 204 on some mutations, and PATCH may return an empty body.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/**
 * Inclusive date-range test on the calendar day of `due`. A task with no due date never matches a
 * date-filtered query — "tasks due on 5 Sep" cannot mean "and also everything with no date".
 */
function dueWithin(due: string | undefined, min?: string, max?: string): boolean {
  if (!min && !max) return true;
  if (!due) return false;
  const day = due.slice(0, 10); // YYYY-MM-DD; lexicographic order matches chronological order
  if (min && day < min) return false;
  if (max && day > max) return false;
  return true;
}

function toTask(t: ApiTask, listId: string): Task {
  return {
    id: t.id,
    listId,
    title: t.title ?? "",
    notes: t.notes,
    status: t.status === "completed" ? "completed" : "needsAction",
    due: t.due,
    completed: t.completed,
    updated: t.updated ?? "",
    parent: t.parent,
    webViewLink: t.webViewLink,
  };
}

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    body: string,
    public readonly retryAfter?: string,
  ) {
    super(`Google Tasks API ${status}: ${hint(status)}${body ? ` — ${body}` : ""}`);
  }
}

/** Turn a bare status into something the model can act on. */
function hint(status: number): string {
  switch (status) {
    case 401:
      return "access token rejected; the connector must re-authorize";
    case 403:
      return "forbidden — missing scope or quota exceeded";
    case 404:
      return "list or task not found";
    case 429:
      return "rate limited; retry later";
    default:
      return "request failed";
  }
}
