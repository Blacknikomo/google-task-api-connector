/**
 * Token primitives: opaque random tokens, SHA-256 hashing for lookup keys,
 * AES-256-GCM for Google refresh tokens at rest, PKCE S256 verification (ADR 0005/0006).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const expected = sha256(codeVerifier);
  const a = Buffer.from(expected);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encrypt(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

export function decrypt(payloadBase64url: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  const buf = Buffer.from(payloadBase64url, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * Access tokens issued to Claude are stateless: `<base64url(payload)>.<hmac>` (ADR 0005 calls them
 * "opaque, signed"). Nothing is persisted for them — ADR 0006's table has no `access#` row type —
 * so validation is a signature + expiry check with no read.
 */
export function signToken(payload: object, keyBase64: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${hmac(body, keyBase64)}`;
}

/** Returns undefined for any malformed, tampered or unparseable token — never throws. */
export function verifyToken<T>(token: string, keyBase64: string): T | undefined {
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) return undefined;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(body, keyBase64));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function hmac(data: string, keyBase64: string): string {
  return createHmac("sha256", Buffer.from(keyBase64, "base64")).update(data).digest("base64url");
}
