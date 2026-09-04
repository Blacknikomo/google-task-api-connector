/**
 * Thin typed wrapper over the Google Tasks REST API v1 (ADR 0004: fetch, not `googleapis`).
 * Docs: https://developers.google.com/tasks/reference/rest
 */
import type { NewTask, Task, TaskList } from "../types.js";

const BASE = "https://tasks.googleapis.com/tasks/v1";

export class GoogleTasksClient {
  constructor(private readonly accessToken: string) {}

  async listTaskLists(): Promise<TaskList[]> {
    // TODO: GET /users/@me/lists (paginate with pageToken)
    throw new NotImplemented("listTaskLists");
  }

  /** Open (needsAction) tasks in a list. Google returns max 100 per page; paginate. */
  async listOpenTasks(listId: string, opts: { dueMin?: string; dueMax?: string } = {}): Promise<Task[]> {
    // TODO: GET /lists/{listId}/tasks?showCompleted=false&showHidden=false&dueMin&dueMax
    void opts;
    throw new NotImplemented("listOpenTasks");
  }

  async createTask(task: NewTask & { listId: string }): Promise<Task> {
    // TODO: POST /lists/{listId}/tasks  body: { title, notes, due: `${due}T00:00:00.000Z` }
    throw new NotImplemented("createTask");
  }

  async completeTask(listId: string, taskId: string): Promise<Task> {
    // TODO: PATCH /lists/{listId}/tasks/{taskId}  body: { status: "completed" }
    throw new NotImplemented("completeTask");
  }

  /** The list Google calls "@default" — resolves to its real id. */
  async defaultListId(): Promise<string> {
    // TODO: GET /lists/@default → id
    throw new NotImplemented("defaultListId");
  }

  // ---- internals -------------------------------------------------------

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
      // TODO: map 401 → re-auth hint, 403 quota, 404 list/task not found, 429 retry-after
      throw new GoogleApiError(res.status, await res.text());
    }
    return (await res.json()) as T;
  }
}

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`Google Tasks API ${status}: ${body}`);
  }
}

export class NotImplemented extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
  }
}
