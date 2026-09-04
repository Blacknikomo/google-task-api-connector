/** Domain types shared across tools, Google client and auth. */

export interface TaskList {
  id: string;
  title: string;
  updated: string;
}

export interface Task {
  id: string;
  listId: string;
  title: string;
  notes?: string;
  status: "needsAction" | "completed";
  /** RFC 3339 date (Google Tasks stores date only; time part is always 00:00:00Z) */
  due?: string;
  completed?: string;
  updated: string;
  parent?: string;
  webViewLink?: string;
}

export interface NewTask {
  listId?: string;
  title: string;
  notes?: string;
  /** ISO date, YYYY-MM-DD */
  due?: string;
}

export interface TaskMatch {
  task: Task;
  /** 0..1, 1 = identical normalized title */
  score: number;
}

/** Identity resolved from a validated bearer token, passed into every tool handler. */
export interface AuthContext {
  /** Google account email (from ID token at consent time) */
  email: string;
  /** Valid Google access token for the Tasks API */
  googleAccessToken: string;
}
