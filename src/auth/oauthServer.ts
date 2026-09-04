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
import { Hono, type Context } from "hono";
import type { Config } from "../config.js";
import type { RefreshGrant, TokenStore } from "./store.js";
import { encrypt, randomToken, sha256, signToken, verifyPkce } from "./crypto.js";
import { buildGoogleAuthUrl, emailFromIdToken, exchangeCode, GoogleOAuthError, TASKS_SCOPE } from "../google/oauth.js";

export const ACCESS_TOKEN_TTL = 60 * 60; // 1h
export const CODE_TTL = 10 * 60;
export const STATE_TTL = 10 * 60;
export const ISSUED_SCOPE = "tasks";

export interface OAuthDeps {
  cfg: Config;
  store: TokenStore;
}

/** Claims inside the signed access token we issue to Claude. Nothing is stored server-side. */
export interface AccessClaims {
  /** Google account email */
  sub: string;
  /** sha256 of the refresh token whose grant row holds the Google refresh token */
  rgh: string;
  /** epoch seconds */
  exp: number;
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
      scopes_supported: [ISSUED_SCOPE],
    });
  });

  // RFC 9728 – lets the client discover which authorization server protects /mcp.
  // The spec derives the metadata URL by inserting the well-known segment *before* the resource
  // path, so a client looking up https://host/mcp asks for /.well-known/oauth-protected-resource/mcp.
  // Claude uses the bare path (we name it explicitly in WWW-Authenticate); other clients probe the
  // suffixed one, so serve both.
  const protectedResourceMetadata = async (c: Context) => {
    const { cfg } = await deps();
    return c.json({
      resource: `${cfg.baseUrl}/mcp`,
      authorization_servers: [cfg.baseUrl],
      bearer_methods_supported: ["header"],
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

  app.post("/oauth/register", async (c) => {
    const { store } = await deps();

    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400);
    }

    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be a non-empty array of strings" }, 400);
    }
    const invalid = uris.find((u) => !isAllowedRedirectUri(u));
    if (invalid) {
      return c.json({ error: "invalid_redirect_uri", error_description: `redirect_uri must be https or http://localhost: ${invalid}` }, 400);
    }

    const clientId = randomToken(16);
    const clientName = typeof body.client_name === "string" ? body.client_name : undefined;
    await store.putClient({ clientId, clientName, redirectUris: uris, createdAt: Date.now() });

    return c.json(
      {
        client_id: clientId,
        client_name: clientName,
        redirect_uris: uris,
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

    // Errors that cannot be attributed to a registered redirect_uri must NOT redirect (RFC 6749 §4.1.2.1),
    // otherwise the endpoint becomes an open redirector.
    if (!q.client_id) return c.text("Missing client_id", 400);
    const client = await store.getClient(q.client_id);
    if (!client) return c.text("Unknown client_id", 400);
    if (!q.redirect_uri) return c.text("Missing redirect_uri", 400);
    if (!redirectUriMatches(q.redirect_uri, client.redirectUris)) {
      return c.text("redirect_uri does not match the registered URIs", 400);
    }

    // From here the redirect_uri is trusted, so errors go back to the client.
    const reject = (error: string, description: string) =>
      c.redirect(redirectWithParams(q.redirect_uri, { error, error_description: description, state: q.state }), 302);

    if (q.response_type !== "code") return reject("unsupported_response_type", "response_type must be 'code'");
    if (!q.code_challenge) return reject("invalid_request", "code_challenge is required (PKCE)");
    if (q.code_challenge_method !== "S256") return reject("invalid_request", "code_challenge_method must be S256");

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
    const { cfg, store } = await deps();
    const { code, state, error } = c.req.query();

    if (error) return c.text(`Google returned error: ${error}`, 400);
    if (!state || !code) return c.text("Missing code or state", 400);

    const pending = await store.takePending(state);
    if (!pending) return c.text("Unknown or expired state", 400);

    let tokens;
    try {
      tokens = await exchangeCode(cfg, code);
    } catch (e) {
      const msg = e instanceof GoogleOAuthError ? e.message : String(e);
      console.error("Google code exchange failed:", msg);
      return c.redirect(
        redirectWithParams(pending.redirectUri, {
          error: "access_denied",
          error_description: "Google code exchange failed",
          state: pending.clientState,
        }),
        302,
      );
    }

    if (!tokens.refreshToken) {
      // access_type=offline + prompt=consent should always yield one; without it we could never refresh.
      return c.text("Google did not return a refresh token. Remove the app at myaccount.google.com and connect again.", 400);
    }
    if (!tokens.idToken) return c.text("Google did not return an ID token; cannot identify the account.", 400);

    // Google can grant fewer scopes than we ask for — the user can untick a permission on the
    // consent screen, and a scope not declared under "Data access" in the Cloud console may be
    // dropped. Catching it here turns an opaque 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT on the first
    // tool call into a clear failure at connect time.
    if (!tokens.grantedScopes.includes(TASKS_SCOPE)) {
      console.error(`Google granted scopes without ${TASKS_SCOPE}: [${tokens.grantedScopes.join(", ")}]`);
      return c.text(
        "Google did not grant access to your Tasks.\n\n" +
          `Granted: ${tokens.grantedScopes.join(", ") || "(none reported)"}\n` +
          `Required: ${TASKS_SCOPE}\n\n` +
          "On the Google consent screen, tick \"View, edit, create and delete your tasks\". " +
          "If that permission was not offered at all, add the Tasks scope under " +
          "Google Cloud console > APIs & Services > Data access, then connect again.",
        403,
      );
    }

    const email = emailFromIdToken(tokens.idToken);
    if (cfg.allowedEmails.length > 0 && !cfg.allowedEmails.includes(email)) {
      // ADR 0011: defence in depth behind the Google app's Testing-mode test-user list.
      console.warn(`Rejected connection attempt from non-allow-listed account: ${email}`);
      return c.text("This Google account is not allowed to use this connector.", 403);
    }

    const ourCode = randomToken();
    await store.putAuthCode(
      ourCode,
      { ...pending, email, googleRefreshTokenEnc: encrypt(tokens.refreshToken, cfg.tokenSigningKey) },
      CODE_TTL,
    );

    return c.redirect(redirectWithParams(pending.redirectUri, { code: ourCode, state: pending.clientState }), 302);
  });

  app.post("/oauth/token", async (c) => {
    const { cfg, store } = await deps();
    // RFC 6749 §5.1: token responses must not be cached.
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");

    const form = await c.req.parseBody();
    const field = (name: string): string | undefined => {
      const v = form[name];
      return typeof v === "string" && v.length > 0 ? v : undefined;
    };
    const grant = field("grant_type") ?? "";

    if (grant === "authorization_code") {
      const code = field("code");
      const clientId = field("client_id");
      const verifier = field("code_verifier");
      if (!code || !clientId || !verifier) {
        return c.json({ error: "invalid_request", error_description: "code, client_id and code_verifier are required" }, 400);
      }

      const authCode = await store.takeAuthCode(code);
      if (!authCode) return c.json({ error: "invalid_grant", error_description: "unknown or expired code" }, 400);
      if (authCode.clientId !== clientId) return c.json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);

      const redirectUri = field("redirect_uri");
      if (redirectUri && redirectUri !== authCode.redirectUri) {
        return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
      }
      if (!verifyPkce(verifier, authCode.codeChallenge)) {
        return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
      }

      return c.json(
        await issueTokens(cfg, store, {
          clientId: authCode.clientId,
          email: authCode.email,
          googleRefreshTokenEnc: authCode.googleRefreshTokenEnc,
          grantId: randomToken(16),
        }),
      );
    }

    if (grant === "refresh_token") {
      const presented = field("refresh_token");
      if (!presented) return c.json({ error: "invalid_request", error_description: "refresh_token is required" }, 400);

      const oldHash = sha256(presented);
      const existing = await store.getRefreshGrant(oldHash);
      if (!existing) return c.json({ error: "invalid_grant", error_description: "unknown or already-used refresh token" }, 400);

      const clientId = field("client_id");
      if (clientId && clientId !== existing.clientId) {
        return c.json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
      }

      // Rotate: the presented token is single-use (ADR 0006).
      await store.deleteRefreshGrant(oldHash);
      return c.json(await issueTokens(cfg, store, existing));
    }

    return c.json({ error: "unsupported_grant_type", error_description: `unsupported grant_type: ${grant}` }, 400);
  });

  return app;
}

/** Mint a fresh access/refresh pair for a grant, persisting the new refresh token by hash. */
async function issueTokens(cfg: Config, store: TokenStore, grant: RefreshGrant) {
  const refreshToken = randomToken();
  const rgh = sha256(refreshToken);
  await store.putRefreshGrant(rgh, grant);

  const claims: AccessClaims = {
    sub: grant.email,
    rgh,
    exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL,
  };

  return {
    access_token: signToken(claims, cfg.tokenSigningKey),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope: ISSUED_SCOPE,
  };
}

/** https, or http on loopback for local clients (OAuth 2.1 §4.1.3 / RFC 8252). */
function isAllowedRedirectUri(uri: string): boolean {
  const u = parseUrl(uri);
  if (!u) return false;
  return u.protocol === "https:" || isLoopback(u);
}

function parseUrl(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}

function isLoopback(u: URL): boolean {
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
}

/**
 * Exact match, except for loopback redirects: RFC 8252 §7.3 requires the authorization server to
 * accept any port at request time, because a native client binds an ephemeral one and cannot know
 * it when it registers. Everything else about the URI still has to match exactly.
 */
function redirectUriMatches(requested: string, registered: string[]): boolean {
  if (registered.includes(requested)) return true;

  const req = parseUrl(requested);
  if (!req || !isLoopback(req)) return false;

  return registered.some((candidate) => {
    const reg = parseUrl(candidate);
    return (
      reg !== undefined &&
      isLoopback(reg) &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
}

function redirectWithParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
