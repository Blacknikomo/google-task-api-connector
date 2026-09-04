/**
 * DynamoTokenStore against a fake DocumentClient. Covers the two things that are easy to get
 * wrong in the single-table design (ADR 0006): the reserved `expiresAt` TTL attribute, and
 * single-use `take`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const table = new Map<string, Record<string, unknown>>();
const sent: unknown[] = [];

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class Cmd {
    constructor(public input: { Key?: { pk: string }; Item?: Record<string, unknown>; ReturnValues?: string }) {}
  }
  class GetCommand extends Cmd {}
  class PutCommand extends Cmd {}
  class DeleteCommand extends Cmd {}
  return {
    GetCommand,
    PutCommand,
    DeleteCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd: Cmd) {
          sent.push(cmd);
          if (cmd instanceof PutCommand) {
            table.set(cmd.input.Item!.pk as string, { ...cmd.input.Item });
            return {};
          }
          const pk = cmd.input.Key!.pk;
          if (cmd instanceof GetCommand) return { Item: table.get(pk) };
          if (cmd instanceof DeleteCommand) {
            const old = table.get(pk);
            table.delete(pk);
            return cmd.input.ReturnValues === "ALL_OLD" ? { Attributes: old } : {};
          }
          throw new Error("unexpected command");
        },
      }),
    },
  };
});

const { DynamoTokenStore } = await import("../src/auth/store.js");

describe("DynamoTokenStore", () => {
  let store: InstanceType<typeof DynamoTokenStore>;
  beforeEach(() => {
    table.clear();
    sent.length = 0;
    store = new DynamoTokenStore("test-table");
  });

  it("round-trips the cached Google access token including its expiry", async () => {
    // Regression: a field named `expiresAt` would collide with the TTL attribute, which is
    // stripped on read — leaving the expiry undefined and defeating the cache entirely.
    const accessExpiresAt = Math.floor(Date.now() / 1000) + 3600;
    await store.putGoogleAccess("grant-1", { accessToken: "g-access", accessExpiresAt });

    const got = await store.getGoogleAccess("grant-1");
    expect(got).toEqual({ accessToken: "g-access", accessExpiresAt });
    expect(got!.accessExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("strips internal attributes from stored items", async () => {
    await store.putClient({ clientId: "c1", redirectUris: ["https://x/cb"], createdAt: 1 });
    const got = await store.getClient("c1");
    expect(got).not.toHaveProperty("pk");
    expect(got).not.toHaveProperty("expiresAt");
    expect(got).toMatchObject({ clientId: "c1", redirectUris: ["https://x/cb"] });
  });

  it("takes an auth code atomically, via a single delete that returns the old item", async () => {
    await store.putAuthCode(
      "code-1",
      {
        clientId: "c1",
        redirectUri: "https://x/cb",
        codeChallenge: "chal",
        codeChallengeMethod: "S256",
        email: "owner@example.com",
        googleRefreshTokenEnc: "enc",
      },
      600,
    );
    sent.length = 0;

    const first = await store.takeAuthCode("code-1");
    expect(first?.email).toBe("owner@example.com");
    // One round trip, and it is the delete itself that reads — not get-then-delete.
    expect(sent).toHaveLength(1);
    expect((sent[0] as { input: { ReturnValues?: string } }).input.ReturnValues).toBe("ALL_OLD");

    expect(await store.takeAuthCode("code-1")).toBeUndefined();
  });

  it("treats an item past its TTL as absent even before DynamoDB collects it", async () => {
    await store.putPending(
      "s1",
      { clientId: "c1", redirectUri: "https://x/cb", codeChallenge: "chal", codeChallengeMethod: "S256" },
      600,
    );
    // TTL deletion is lazy (up to 48h), so expiry must be enforced on read.
    table.get("state#s1")!.expiresAt = Math.floor(Date.now() / 1000) - 1;
    expect(await store.takePending("s1")).toBeUndefined();
  });
});
