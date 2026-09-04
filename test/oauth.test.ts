/**
 * End-to-end OAuth flow against the real Hono app with the in-memory store (ADR 0005/0006).
 * Google's token endpoint is stubbed; everything else is the production code path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.TOKEN_SIGNING_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.TOKEN_TABLE_NAME = "test-table";
process.env.ALLOWED_EMAILS = "owner@example.com";

const { createApp } = await import("../src/app.js");
const { sha256 } = await import("../src/auth/crypto.js");

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(64);
const CHALLENGE = sha256(VERIFIER);

function idTokenFor(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

/** Stub Google's token endpoint. `email` controls the identity in the returned ID token. */
function stubGoogle(email = "owner@example.com", overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const params = new URLSearchParams(String(init?.body));
      const base =
        params.get("grant_type") === "authorization_code"
          ? {
              access_token: "g-access-1",
              refresh_token: "g-refresh-1",
              expires_in: 3600,
              id_token: idTokenFor(email),
              scope: "https://www.googleapis.com/auth/tasks openid email",
            }
          : { access_token: "g-access-2", expires_in: 3600, scope: "https://www.googleapis.com/auth/tasks openid email" };
      return new Response(JSON.stringify({ ...base, ...overrides }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type App = ReturnType<typeof createApp>;

async function register(app: App, redirectUris = [REDIRECT]) {
  const res = await app.request("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: "Claude" }),
  });
  return { res, body: res.status === 201 ? ((await res.json()) as { client_id: string }) : undefined };
}

/** Drive register → authorize → Google callback, returning the authorization code handed to Claude. */
async function authorizeToCode(app: App, clientId: string) {
  const authRes = await app.request(
    `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
      `&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=claude-state`,
  );
  const googleUrl = new URL(authRes.headers.get("location")!);
  const state = googleUrl.searchParams.get("state")!;

  const cbRes = await app.request(`/oauth/google/callback?code=google-code&state=${state}`);
  return { authRes, cbRes, googleUrl };
}

async function exchange(app: App, clientId: string, code: string, verifier = VERIFIER) {
  const res = await app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier }),
  });
  return { res, body: (await res.json()) as Record<string, string> };
}

/** Run register -> authorize -> callback -> token and return the issued access token. */
async function connect(app: App): Promise<string> {
  const { body: client } = await register(app);
  const { cbRes } = await authorizeToCode(app, client!.client_id);
  const code = new URL(cbRes.headers.get("location")!).searchParams.get("code")!;
  const { body } = await exchange(app, client!.client_id, code);
  return body.access_token;
}

describe("OAuth authorization server", () => {
  let app: App;
  beforeEach(() => {
    vi.unstubAllGlobals();
    app = createApp();
  });

  it("completes register → authorize → callback → token and issues a usable bearer", async () => {
    stubGoogle();
    const { body: client } = await register(app);
    const { authRes, cbRes } = await authorizeToCode(app, client!.client_id);

    expect(authRes.status).toBe(302);
    expect(authRes.headers.get("location")).toContain("accounts.google.com");

    expect(cbRes.status).toBe(302);
    const back = new URL(cbRes.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("claude-state");

    const code = back.searchParams.get("code")!;
    const { res, body } = await exchange(app, client!.client_id, code);
    expect(res.status).toBe(200);
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
  });

  it("serves protected-resource metadata at both RFC 9728 paths", async () => {
    // Claude reads the bare path; other clients (ChatGPT) probe the resource-suffixed one.
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as { resource: string; authorization_servers: string[] };
      expect(body.resource).toMatch(/\/mcp$/);
      expect(body.authorization_servers).toHaveLength(1);
    }
  });

  it("registers a ChatGPT-style redirect uri", async () => {
    // ChatGPT self-registers via DCR with one of these callbacks.
    for (const uri of [
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector/oauth/abc123",
    ]) {
      const { res } = await register(app, [uri]);
      expect(res.status, uri).toBe(201);
    }
  });

  it("rejects a mismatched PKCE verifier", async () => {
    stubGoogle();
    const { body: client } = await register(app);
    const { cbRes } = await authorizeToCode(app, client!.client_id);
    const code = new URL(cbRes.headers.get("location")!).searchParams.get("code")!;

    const { res, body } = await exchange(app, client!.client_id, code, "b".repeat(64));
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
  });

  it("makes the authorization code single-use", async () => {
    stubGoogle();
    const { body: client } = await register(app);
    const { cbRes } = await authorizeToCode(app, client!.client_id);
    const code = new URL(cbRes.headers.get("location")!).searchParams.get("code")!;

    expect((await exchange(app, client!.client_id, code)).res.status).toBe(200);
    const replay = await exchange(app, client!.client_id, code);
    expect(replay.res.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
  });

  it("refuses an unregistered redirect_uri without redirecting", async () => {
    const { body: client } = await register(app);
    const res = await app.request(
      `/oauth/authorize?client_id=${client!.client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}` +
        `&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("requires PKCE, reporting the error back to the registered redirect_uri", async () => {
    const { body: client } = await register(app);
    const res = await app.request(
      `/oauth/authorize?client_id=${client!.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("rejects registration of a non-https redirect_uri", async () => {
    const { res } = await register(app, ["http://evil.example/cb"]);
    expect(res.status).toBe(400);
  });

  it("blocks a Google account that is not on the allow-list (ADR 0011)", async () => {
    stubGoogle("stranger@example.com");
    const { body: client } = await register(app);
    const { cbRes } = await authorizeToCode(app, client!.client_id);
    expect(cbRes.status).toBe(403);
  });

  it("refuses the connection when Google withholds the Tasks scope", async () => {
    // The user can untick the Tasks permission on the consent screen, or the scope may not be
    // declared under Data access — either way the token is useless for the Tasks API.
    stubGoogle("owner@example.com", { scope: "openid email" });
    const { body: client } = await register(app);
    const { cbRes } = await authorizeToCode(app, client!.client_id);

    expect(cbRes.status).toBe(403);
    expect(await cbRes.text()).toMatch(/did not grant access to your Tasks/i);
  });

  it("requests the Tasks scope, offline access and forced consent", async () => {
    stubGoogle();
    const { body: client } = await register(app);
    const { authRes } = await authorizeToCode(app, client!.client_id);
    const q = new URL(authRes.headers.get("location")!).searchParams;

    expect(q.get("scope")!.split(" ")).toContain("https://www.googleapis.com/auth/tasks");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
  });

  it("fails the connection when Google returns no refresh token", async () => {
    stubGoogle("owner@example.com", { refresh_token: undefined });
    const { body: client } = await register(app);
    const { cbRes } = await authorizeToCode(app, client!.client_id);
    expect(cbRes.status).toBe(400);
  });

  it("rotates refresh tokens and refuses the used one", async () => {
    stubGoogle();
    const { body: client } = await register(app);
    const { cbRes } = await authorizeToCode(app, client!.client_id);
    const code = new URL(cbRes.headers.get("location")!).searchParams.get("code")!;
    const first = (await exchange(app, client!.client_id, code)).body;

    const refresh = async (token: string) =>
      app.request("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: client!.client_id }),
      });

    const rotated = await refresh(first.refresh_token);
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as Record<string, string>;
    expect(next.refresh_token).not.toBe(first.refresh_token);

    const replay = await refresh(first.refresh_token);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as Record<string, string>).error).toBe("invalid_grant");
  });
});

describe("bearer auth on /mcp", () => {
  let app: App;
  beforeEach(() => {
    vi.unstubAllGlobals();
    app = createApp();
  });

  const post = (token?: string) =>
    app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });

  it("lets a CORS preflight through without a token", async () => {
    // Browsers never attach Authorization to a preflight; 401-ing it breaks the whole flow.
    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://chatgpt.com", "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204);
  });

  it("401s without a token", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });

  it("401s on a tampered token", async () => {
    stubGoogle();
    const token = await connect(app);

    const [payload] = token.split(".");
    expect((await post(`${payload}.forgedsignature`)).status).toBe(401);
  });

  it("answers initialize with a non-empty JSON-RPC result", async () => {
    stubGoogle();
    const token = await connect(app);

    const res = await post(token);
    expect(res.status).toBe(200);
    // Regression: with SSE mode plus an eager transport.close() this was a 200 with an EMPTY body,
    // which the client reports as a connection error rather than a failure.
    expect(res.headers.get("content-type")).toContain("application/json");
    const text = await res.text();
    expect(text).not.toBe("");
    expect(JSON.parse(text)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "google-tasks-connector" } },
    });
  });

  it("lists every tool over the transport", async () => {
    stubGoogle();
    const token = await connect(app);

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    const body = (await res.json()) as { result?: { tools?: { name: string }[] } };
    expect(body.result?.tools?.map((t) => t.name).sort()).toEqual(
      ["complete_task", "create_task", "find_tasks", "list_task_lists", "list_tasks"].sort(),
    );
  });
});
