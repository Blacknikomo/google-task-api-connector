/**
 * The connector as an OAuth 2.1 *authorization server* towards Claude (ADR 0005).
 *
 * Flow:
 *   Claude → GET  /.well-known/oauth-authorization-server   (metadata, RFC 8414)
 *   Claude → POST /oauth/register                           (dynamic client registration, RFC 7591)
 *   Claude → GET  /oauth/authorize?...&code_challenge=...   → 302 to Google consent
 *   Google → GET  /oauth/google/callback?code&state         → 302 to Claude redirect_uri with our code
 *   Claude → POST /oauth/token  (authorization_code + code_verifier | refresh_token)
 *   Claude → POST /mcp  Authorization: Bearer <access_token>
 */
import { Hono } from "hono";
import type { Config } from "../config.js";
import type { TokenStore } from "./store.js";
import { randomToken, sha256 } from "./crypto.js";
import { buildGoogleAuthUrl } from "../google/oauth.js";

export const ACCESS_TOKEN_TTL = 60 * 60; // 1h
export const CODE_TTL = 10 * 60;
export const STATE_TTL = 10 * 60;

export interface OAuthDeps {
  cfg: Config;
  store: TokenStore;
}

export function oauthRoutes(deps: () => Promise<OAuthDeps>): Hono {
  const app = new Hono();

  app.get("/.well-known/oauth-authorization-server", async (c) => {
    const { cfg } = await deps();
    return c.json({
      issuer: cfg.baseUrl,
      authorization_endpoint: `${cfg.baseUrl}/oauth/authorize`,
      token_endpoint: `${cfg.baseUrl}/oauth/token`,
      registration_endpoint: `${cfg.baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["tasks"],
    });
  });

  // RFC 9728 – lets the client discover which authorization server protects /mcp
  app.get("/.well-known/oauth-protected-resource", async (c) => {
    const { cfg } = await deps();
    return c.json({
      resource: `${cfg.baseUrl}/mcp`,
      authorization_servers: [cfg.baseUrl],
      bearer_methods_supported: ["header"],
    });
  });

  app.post("/oauth/register", async (c) => {
    const { store } = await deps();
    const body = await c.req.json<{ redirect_uris?: string[]; client_name?: string }>();
    // TODO: validate redirect_uris are https (or http://localhost), reject empty
    const clientId = randomToken(16);
    await store.putClient({
      clientId,
      clientName: body.client_name,
      redirectUris: body.redirect_uris ?? [],
      createdAt: Date.now(),
    });
    return c.json(
      {
        client_id: clientId,
        client_name: body.client_name,
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  app.get("/oauth/authorize", async (c) => {
    const { cfg, store } = await deps();
    const q = c.req.query();
    // TODO: validate client_id exists, redirect_uri ∈ client.redirectUris,
    //       response_type === "code", code_challenge_method === "S256"; on error redirect with error=invalid_request
    const state = randomToken(24);
    await store.putPending(
      state,
      {
        clientId: q.client_id,
        redirectUri: q.redirect_uri,
        codeChallenge: q.code_challenge,
        codeChallengeMethod: "S256",
        clientState: q.state,
        scope: q.scope,
      },
      STATE_TTL,
    );
    return c.redirect(buildGoogleAuthUrl(cfg, state), 302);
  });

  app.get("/oauth/google/callback", async (c) => {
    const { store } = await deps();
    const { code, state, error } = c.req.query();
    if (error) return c.text(`Google returned error: ${error}`, 400);
    const pending = await store.takePending(state);
    if (!pending) return c.text("Unknown or expired state", 400);
    // TODO:
    //  1. exchangeCode(cfg, code) → tokens (must include refreshToken)
    //  2. email = emailFromIdToken(tokens.idToken); enforce cfg.allowedEmails (ADR 0011)
    //  3. ourCode = randomToken(); store.putAuthCode(ourCode, { ...pending, email, googleRefreshTokenEnc: encrypt(...) }, CODE_TTL)
    //  4. redirect to `${pending.redirectUri}?code=${ourCode}&state=${pending.clientState}`
    void code;
    return c.text("Google callback not implemented", 501);
  });

  app.post("/oauth/token", async (c) => {
    const { store } = await deps();
    const form = await c.req.parseBody();
    const grant = String(form.grant_type ?? "");
    if (grant === "authorization_code") {
      // TODO:
      //  - takeAuthCode(code); verify client_id, redirect_uri, verifyPkce(code_verifier, codeChallenge)
      //  - issue access token (signed/opaque, ACCESS_TOKEN_TTL) + refresh token (store by sha256 hash)
      //  - respond { access_token, token_type: "Bearer", expires_in, refresh_token, scope }
      void store;
      return c.json({ error: "unsupported_grant_type", error_description: "not implemented" }, 400);
    }
    if (grant === "refresh_token") {
      // TODO: rotate: getRefreshGrant(sha256(old)) → delete → issue new pair
      return c.json({ error: "unsupported_grant_type", error_description: "not implemented" }, 400);
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  return app;
}

/** Stable, non-reversible id used as cache key for Google access tokens. */
export function accessTokenHash(bearer: string): string {
  return sha256(bearer);
}
