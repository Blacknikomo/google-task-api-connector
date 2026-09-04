/**
 * Validates the bearer token Claude sends on /mcp and resolves it to an AuthContext
 * with a live Google access token (ADR 0005). Returns 401 + WWW-Authenticate on failure so
 * the client restarts the OAuth flow.
 */
import type { Context, Next } from "hono";
import type { Config } from "../config.js";
import type { TokenStore } from "./store.js";
import type { AuthContext } from "../types.js";
import type { AccessClaims } from "./oauthServer.js";
import { decrypt, verifyToken } from "./crypto.js";
import { GoogleOAuthError, refreshAccessToken } from "../google/oauth.js";

export type Variables = { auth: AuthContext };

export function bearerAuth(deps: () => Promise<{ cfg: Config; store: TokenStore }>) {
  return async (c: Context<{ Variables: Variables }>, next: Next) => {
    const { cfg, store } = await deps();
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) return unauthorized(c, cfg, "missing bearer token");

    const claims = verifyToken<AccessClaims>(token, cfg.tokenSigningKey);
    if (!claims?.rgh || !claims.sub) return unauthorized(c, cfg, "malformed or unsigned token");
    if (typeof claims.exp !== "number" || claims.exp < now()) return unauthorized(c, cfg, "token expired");

    // The grant row is deleted when the refresh token rotates or the user is revoked.
    const grant = await store.getRefreshGrant(claims.rgh);
    if (!grant) return unauthorized(c, cfg, "grant revoked or superseded; re-authorize");

    let googleAccessToken: string;
    const cached = await store.getGoogleAccess(grant.grantId);
    if (cached && cached.accessExpiresAt > now()) {
      googleAccessToken = cached.accessToken;
    } else {
      try {
        const refreshed = await refreshAccessToken(cfg, decrypt(grant.googleRefreshTokenEnc, cfg.tokenSigningKey));
        googleAccessToken = refreshed.accessToken;
        await store.putGoogleAccess(grant.grantId, {
          accessToken: refreshed.accessToken,
          accessExpiresAt: refreshed.expiresAt,
        });
      } catch (e) {
        if (e instanceof GoogleOAuthError && e.requiresReconnect) {
          // Testing-mode refresh tokens expire after 7 days (ADR 0011); the user must reconnect.
          await store.deleteRefreshGrant(claims.rgh);
          return unauthorized(c, cfg, "Google access was revoked or expired; reconnect the connector");
        }
        throw e;
      }
    }

    c.set("auth", { email: grant.email, googleAccessToken });
    await next();
  };
}

function unauthorized(c: Context, cfg: Config, description: string) {
  c.header(
    "WWW-Authenticate",
    `Bearer resource_metadata="${cfg.baseUrl}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${description}"`,
  );
  return c.json({ error: "invalid_token", error_description: description }, 401);
}

const now = () => Math.floor(Date.now() / 1000);
