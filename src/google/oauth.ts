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
  // TODO: POST TOKEN_URL grant_type=authorization_code
  void code;
  throw new Error("exchangeCode not implemented");
}

export async function refreshAccessToken(cfg: Config, refreshToken: string): Promise<GoogleTokens> {
  // TODO: POST TOKEN_URL grant_type=refresh_token; handle invalid_grant → require re-connect
  void refreshToken;
  throw new Error("refreshAccessToken not implemented");
}

/** Extract email from the ID token. Signature verification is optional here: the token came directly from Google over TLS. */
export function emailFromIdToken(idToken: string): string {
  const payload = idToken.split(".")[1];
  const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string };
  if (!json.email) throw new Error("ID token has no email claim");
  return json.email.toLowerCase();
}

export { TOKEN_URL };
