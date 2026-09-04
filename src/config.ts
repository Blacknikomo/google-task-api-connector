/**
 * Runtime configuration.
 *
 * Local dev: values come from `.env` (loaded by `node --env-file`).
 * AWS: Google credentials + signing key come from Secrets Manager (ADR 0007),
 *      everything else from Lambda env vars set in template.yaml.
 */
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

export interface Config {
  /** Public base URL without trailing slash, e.g. https://abc.execute-api.eu-central-1.amazonaws.com */
  baseUrl: string;
  google: {
    clientId: string;
    clientSecret: string;
    /** Scopes requested from Google (ADR 0011) */
    scopes: string[];
  };
  /** 32-byte key (base64) used to sign/encrypt tokens issued to Claude and to encrypt Google refresh tokens */
  tokenSigningKey: string;
  tokenTableName: string;
  /** Empty array = no server-side restriction (Google app Testing mode still applies) */
  allowedEmails: string[];
  /** Similarity threshold for duplicate detection (ADR 0010) */
  duplicateThreshold: number;
}

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/tasks", "openid", "email"];

let cached: Config | undefined;

/**
 * Resolve config once per container. `baseUrl` may be overridden per request
 * (API Gateway host is only known from the incoming request when no custom domain is set).
 */
export async function loadConfig(requestBaseUrl?: string): Promise<Config> {
  if (!cached) {
    const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
    const google = isLambda ? await readSecret<{ client_id: string; client_secret: string }>(env("GOOGLE_OAUTH_SECRET_NAME")) : { client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET") };
    const signing = isLambda ? await readSecret<{ key: string }>(env("TOKEN_SIGNING_SECRET_NAME")) : { key: env("TOKEN_SIGNING_KEY") };

    cached = {
      baseUrl: process.env.BASE_URL ?? "",
      google: { clientId: google.client_id, clientSecret: google.client_secret, scopes: GOOGLE_SCOPES },
      tokenSigningKey: signing.key,
      tokenTableName: env("TOKEN_TABLE_NAME"),
      allowedEmails: (process.env.ALLOWED_EMAILS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      duplicateThreshold: Number(process.env.DUPLICATE_THRESHOLD ?? "0.8"),
    };
  }
  return requestBaseUrl && !process.env.BASE_URL ? { ...cached, baseUrl: requestBaseUrl } : cached;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

async function readSecret<T>(secretId: string): Promise<T> {
  const client = new SecretsManagerClient({});
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!out.SecretString) throw new Error(`Secret ${secretId} has no string value`);
  return JSON.parse(out.SecretString) as T;
}
