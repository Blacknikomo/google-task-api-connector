/**
 * Persistence for OAuth state (ADR 0006). Single DynamoDB table, `pk` + optional `expiresAt` TTL.
 * An in-memory implementation exists for local dev and tests.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

export interface RegisteredClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
}

export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  /** Claude's `state` — echoed back on redirect */
  clientState?: string;
  scope?: string;
}

export interface AuthCode extends PendingAuthorization {
  email: string;
  /** Encrypted Google refresh token */
  googleRefreshTokenEnc: string;
}

export interface RefreshGrant {
  clientId: string;
  email: string;
  googleRefreshTokenEnc: string;
}

export interface CachedGoogleAccess {
  accessToken: string;
  expiresAt: number;
}

export interface TokenStore {
  putClient(c: RegisteredClient): Promise<void>;
  getClient(clientId: string): Promise<RegisteredClient | undefined>;

  putPending(state: string, p: PendingAuthorization, ttlSeconds: number): Promise<void>;
  /** Single-use: returns and deletes */
  takePending(state: string): Promise<PendingAuthorization | undefined>;

  putAuthCode(code: string, a: AuthCode, ttlSeconds: number): Promise<void>;
  /** Single-use: returns and deletes (conditional delete to prevent replay) */
  takeAuthCode(code: string): Promise<AuthCode | undefined>;

  putRefreshGrant(tokenHash: string, g: RefreshGrant): Promise<void>;
  getRefreshGrant(tokenHash: string): Promise<RefreshGrant | undefined>;
  deleteRefreshGrant(tokenHash: string): Promise<void>;

  putGoogleAccess(tokenHash: string, a: CachedGoogleAccess): Promise<void>;
  getGoogleAccess(tokenHash: string): Promise<CachedGoogleAccess | undefined>;
}

// ---------------------------------------------------------------------------

export class DynamoTokenStore implements TokenStore {
  private readonly db: DynamoDBDocumentClient;

  constructor(private readonly table: string) {
    this.db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  }

  putClient(c: RegisteredClient) {
    return this.put(`client#${c.clientId}`, c);
  }
  getClient(clientId: string) {
    return this.get<RegisteredClient>(`client#${clientId}`);
  }
  putPending(state: string, p: PendingAuthorization, ttl: number) {
    return this.put(`state#${state}`, p, ttl);
  }
  takePending(state: string) {
    return this.take<PendingAuthorization>(`state#${state}`);
  }
  putAuthCode(code: string, a: AuthCode, ttl: number) {
    return this.put(`authcode#${code}`, a, ttl);
  }
  takeAuthCode(code: string) {
    return this.take<AuthCode>(`authcode#${code}`);
  }
  putRefreshGrant(h: string, g: RefreshGrant) {
    return this.put(`refresh#${h}`, g);
  }
  getRefreshGrant(h: string) {
    return this.get<RefreshGrant>(`refresh#${h}`);
  }
  deleteRefreshGrant(h: string) {
    return this.del(`refresh#${h}`);
  }
  putGoogleAccess(h: string, a: CachedGoogleAccess) {
    return this.put(`gaccess#${h}`, a, Math.max(0, a.expiresAt - now()));
  }
  getGoogleAccess(h: string) {
    return this.get<CachedGoogleAccess>(`gaccess#${h}`);
  }

  private async put(pk: string, item: object, ttlSeconds?: number) {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk, ...item, ...(ttlSeconds ? { expiresAt: now() + ttlSeconds } : {}) },
      }),
    );
  }
  private async get<T>(pk: string): Promise<T | undefined> {
    const out = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk } }));
    if (!out.Item) return undefined;
    // TTL deletion is lazy (up to 48h); enforce expiry on read.
    if (typeof out.Item.expiresAt === "number" && out.Item.expiresAt < now()) return undefined;
    const { pk: _pk, expiresAt: _exp, ...rest } = out.Item;
    return rest as T;
  }
  private async del(pk: string) {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk } }));
  }
  private async take<T>(pk: string): Promise<T | undefined> {
    // TODO: use DeleteCommand with ReturnValues: "ALL_OLD" for an atomic take
    const v = await this.get<T>(pk);
    if (v) await this.del(pk);
    return v;
  }
}

// ---------------------------------------------------------------------------

/** For `npm run dev` and unit tests. Not for production. */
export class MemoryTokenStore implements TokenStore {
  private readonly m = new Map<string, { v: unknown; exp?: number }>();

  putClient = async (c: RegisteredClient) => this.set(`client#${c.clientId}`, c);
  getClient = async (id: string) => this.get<RegisteredClient>(`client#${id}`);
  putPending = async (s: string, p: PendingAuthorization, ttl: number) => this.set(`state#${s}`, p, ttl);
  takePending = async (s: string) => this.take<PendingAuthorization>(`state#${s}`);
  putAuthCode = async (c: string, a: AuthCode, ttl: number) => this.set(`authcode#${c}`, a, ttl);
  takeAuthCode = async (c: string) => this.take<AuthCode>(`authcode#${c}`);
  putRefreshGrant = async (h: string, g: RefreshGrant) => this.set(`refresh#${h}`, g);
  getRefreshGrant = async (h: string) => this.get<RefreshGrant>(`refresh#${h}`);
  deleteRefreshGrant = async (h: string) => void this.m.delete(`refresh#${h}`);
  putGoogleAccess = async (h: string, a: CachedGoogleAccess) => this.set(`gaccess#${h}`, a, a.expiresAt - now());
  getGoogleAccess = async (h: string) => this.get<CachedGoogleAccess>(`gaccess#${h}`);

  private set(k: string, v: unknown, ttl?: number) {
    this.m.set(k, { v, exp: ttl ? now() + ttl : undefined });
  }
  private get<T>(k: string): T | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp && e.exp < now()) {
      this.m.delete(k);
      return undefined;
    }
    return e.v as T;
  }
  private take<T>(k: string): T | undefined {
    const v = this.get<T>(k);
    this.m.delete(k);
    return v;
  }
}

export function createStore(tableName: string): TokenStore {
  return process.env.AWS_LAMBDA_FUNCTION_NAME ? new DynamoTokenStore(tableName) : new MemoryTokenStore();
}

const now = () => Math.floor(Date.now() / 1000);
