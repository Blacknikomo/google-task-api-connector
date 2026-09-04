/**
 * Google-side OAuth 2.0 helpers (the connector acting as an OAuth *client*, ADR 0005).
 * Endpoints: https://accounts.google.com/.well-known/openid-configuration
 */
import type { Config } from "../config.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleTokens {
  accessToken: string;
  /** Present only when access_type=offline and prompt=consent (first grant) */
  refreshToken?: string;
  expiresAt: number; // epoch seconds
  idToken?: string;
}

/** A Google token-endpoint failure. `invalid_grant` means the user must re-connect (ADR 0011). */
export class GoogleOAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    description?: string,
  ) {
    super(`Google OAuth ${status} ${code}${description ? `: ${description}` : ""}`);
  }
  /** Refresh token revoked, expired (Testing-mode apps expire them after 7 days) or already used. */
  get requiresReconnect(): boolean {
    return this.code === "invalid_grant";
  }
}

export function googleRedirectUri(cfg: Config): string {
  return `${cfg.baseUrl}/oauth/google/callback`;
}

/** Build the consent URL; `state` links the Google callback back to the pending Claude authorization (ADR 0006). */
export function buildGoogleAuthUrl(cfg: Config, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.google.clientId,
    redirect_uri: googleRedirectUri(cfg),
    response_type: "code",
    scope: cfg.google.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

export async function exchangeCode(cfg: Config, code: string): Promise<GoogleTokens> {
  return tokenRequest(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: googleRedirectUri(cfg),
  });
}

export async function refreshAccessToken(cfg: Config, refreshToken: string): Promise<GoogleTokens> {
  return tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken });
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(cfg: Config, params: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...params,
      client_id: cfg.google.clientId,
      client_secret: cfg.google.clientSecret,
    }),
  });

  let json: GoogleTokenResponse;
  try {
    json = (await res.json()) as GoogleTokenResponse;
  } catch {
    throw new GoogleOAuthError("invalid_response", res.status, "token endpoint returned non-JSON");
  }

  if (!res.ok || !json.access_token) {
    throw new GoogleOAuthError(json.error ?? "unknown_error", res.status, json.error_description);
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    // 60 s of slack so a token is never handed out moments before Google stops accepting it.
    expiresAt: Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600) - 60,
    idToken: json.id_token,
  };
}

/** Extract email from the ID token. Signature verification is optional here: the token came directly from Google over TLS. */
export function emailFromIdToken(idToken: string): string {
  const payload = idToken.split(".")[1];
  const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string };
  if (!json.email) throw new Error("ID token has no email claim");
  return json.email.toLowerCase();
}

export { TOKEN_URL };
