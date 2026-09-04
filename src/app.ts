/**
 * HTTP application (Hono, ADR 0012). Shared by the Lambda handler and the local dev server.
 */
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { createStore, type TokenStore } from "./auth/store.js";
import { oauthRoutes } from "./auth/oauthServer.js";
import { bearerAuth, type Variables } from "./auth/bearer.js";
import { handleMcpRequest } from "./mcp/server.js";

export function createApp(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  // Config depends on the request host when no BASE_URL is set (API Gateway default domain).
  let baseUrlFromRequest: string | undefined;
  // Reused across invocations in a warm container: the store owns a DynamoDB client whose
  // connection pool is worth keeping.
  let store: TokenStore | undefined;
  const deps = async () => {
    const cfg = await loadConfig(baseUrlFromRequest);
    store ??= createStore(cfg.tokenTableName);
    return { cfg, store };
  };

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    baseUrlFromRequest = `${url.protocol}//${url.host}`;
    await next();
  });

  app.get("/", (c) => c.text("google-tasks-connector: MCP endpoint at /mcp"));
  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/", oauthRoutes(deps));

  // A CORS preflight carries no Authorization header by definition, so it must never go through
  // bearer auth — hence the middleware is attached to POST rather than to the path.
  app.options("/mcp", (c) => c.body(null, 204));
  app.post("/mcp", bearerAuth(deps), async (c) => {
    const { cfg } = await deps();
    return handleMcpRequest(c.req.raw, cfg, c.get("auth"));
  });
  app.get("/mcp", (c) => c.text("Method Not Allowed: stateless transport, use POST", 405));
  app.delete("/mcp", (c) => c.body(null, 204));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error", message: err.message }, 500);
  });

  return app;
}
