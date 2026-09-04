/**
 * Validates the bearer token Claude sends on /mcp and resolves it to an AuthContext
 * with a live Google access token (ADR 0005). Returns 401 + WWW-Authenticate on failure so
 * the client restarts the OAuth flow.
 */
import type { Context, Next } from "hono";
import type { Config } from "../config.js";
import type { TokenStore } from "./store.js";
import type { AuthContext } from "../types.js";

export type Variables = { auth: AuthContext };

export function bearerAuth(deps: () => Promise<{ cfg: Config; store: TokenStore }>) {
  return async (c: Context<{ Variables: Variables }>, next: Next) => {
    const { cfg, store } = await deps();
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) return unauthorized(c, cfg, "missing bearer token");

    // TODO:
    //  1. verify our access token (signature + expiry) → { email, refreshGrantHash }
    //  2. getGoogleAccess(refreshGrantHash) → if valid use it,
    //     else decrypt Google refresh token, refreshAccessToken(), putGoogleAccess()
    //  3. c.set("auth", { email, googleAccessToken })
    void store;
    return unauthorized(c, cfg, "token validation not implemented");
    // await next();
  };
}

function unauthorized(c: Context, cfg: Config, description: string) {
  c.header(
    "WWW-Authenticate",
    `Bearer resource_metadata="${cfg.baseUrl}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${description}"`,
  );
  return c.json({ error: "invalid_token", error_description: description }, 401);
}
