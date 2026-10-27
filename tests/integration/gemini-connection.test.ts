import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  connectionAad,
  decryptSecret,
  DecryptionError,
  keyFingerprint,
  readProviderKeyMaterial,
} from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import {
  decryptGeminiApiKey,
  deleteGeminiConnection,
  getGeminiConnection,
  saveGeminiApiKey,
} from "@/server/domain/providers/gemini-connection";
import { cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// Gemini BYOK 연결 서비스 (architecture.md §8.1·§8.3, database.md §3.2·§7).
const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "integration-fingerprint-secret-0123456789",
});

const VIEW_KEYS = [
  "blockedUntil",
  "createdAt",
  "dailyRequestLimit",
  "dailyTokenLimit",
  "defaultModel",
  "keyLast4",
  "lastErrorCode",
  "lastVerifiedAt",
  "provider",
  "status",
  "updatedAt",
];

async function newUser(label: string) {
  const user = await createTestUser(label);
  return { ...user, uid: asAuthenticatedUserId(user.id) };
}

async function rawRow(userId: string) {
  return prisma.aiProviderConnection.findFirstOrThrow({ where: { userId, provider: "GEMINI" } });
}

/** 행 전체(모든 컬럼)를 텍스트로 만든 값에 원문 키가 있는지 */
async function rowContainsPlaintext(userId: string, apiKey: string) {
  const rows = await prisma.$queryRaw<{ t: string }[]>`
    SELECT row_to_json(c)::text AS t FROM "AiProviderConnection" c WHERE "userId" = ${userId}`;
  const encrypted = await rawRow(userId);
  return rows.some((r) => r.t.includes(apiKey)) || Buffer.from(encrypted.encryptedKey).includes(Buffer.from(apiKey));
}

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("키 등록", () => {
  it("평문을 저장하지 않고, 조회 결과에는 허용된 필드만 담긴다", async () => {
    const user = await newUser("register");
    const apiKey = fakeGeminiKey("register");

    const { connection, created } = await saveGeminiApiKey(user.uid, apiKey, material);

    expect(created).toBe(true);
    expect(Object.keys(connection).sort()).toEqual(VIEW_KEYS);
    expect(connection).toMatchObject({ provider: "GEMINI", status: "UNVERIFIED", keyLast4: apiKey.slice(-4), defaultModel: null });
    expect(JSON.stringify(connection)).not.toContain(apiKey);

    const row = await rawRow(user.id);
    expect(await rowContainsPlaintext(user.id, apiKey)).toBe(false);
    expect(row.keyFingerprint).toBe(keyFingerprint(apiKey, material));
    expect(row.encryptionKeyVersion).toBe(1);
    expect(await decryptGeminiApiKey(user.uid, material)).toBe(apiKey);
    expect(await getGeminiConnection(user.uid)).toEqual(connection);
  });

  it("암호문은 그 사용자·연결에 묶인다 (다른 행으로 옮기면 복호화 실패)", async () => {
    const a = await newUser("aad-a");
    const b = await newUser("aad-b");
    await saveGeminiApiKey(a.uid, fakeGeminiKey("aad-a"), material);
    await saveGeminiApiKey(b.uid, fakeGeminiKey("aad-b"), material);
    const rowA = await rawRow(a.id);

    await prisma.aiProviderConnection.update({
      where: { id: (await rawRow(b.id)).id },
      data: { encryptedKey: rowA.encryptedKey, keyIv: rowA.keyIv, keyAuthTag: rowA.keyAuthTag },
    });

    await expect(decryptGeminiApiKey(b.uid, material)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("다른 마스터 키로는 복호화할 수 없다", async () => {
    const user = await newUser("master");
    await saveGeminiApiKey(user.uid, fakeGeminiKey("master"), material);
    const other = readProviderKeyMaterial({ PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"), KEY_FINGERPRINT_SECRET: "o".repeat(32) });
    await expect(decryptGeminiApiKey(user.uid, other)).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe("키 교체 (D8)", () => {
  it("같은 연결 행을 유지하고, 사용량·한도·모델은 그대로, 백오프만 초기화한다", async () => {
    const user = await newUser("replace");
    const world = await createTestWorld(user.id);
    const oldKey = fakeGeminiKey("old");
    const newKey = fakeGeminiKey("new");
    await saveGeminiApiKey(user.uid, oldKey, material);
    const before = await rawRow(user.id);

    // 교체 전 상태: 한도 설정, 사용량 기록, 백오프 진행 중, 검증 완료, 모델 선택됨, 요청 로그
    await prisma.aiProviderConnection.update({
      where: { id: before.id },
      data: {
        dailyRequestLimit: 100,
        dailyTokenLimit: 50_000,
        consecutiveFailures: 4,
        backoffLevel: 3,
        blockedUntil: new Date(Date.now() + 60_000),
        blockReason: "RATE_LIMITED",
        status: "ACTIVE",
        lastVerifiedAt: new Date(),
        lastErrorCode: "RESOURCE_EXHAUSTED",
        defaultModel: "test-model-placeholder",
      },
    });
    await prisma.apiUsageDaily.createMany({
      data: [
        { connectionId: before.id, usageDate: new Date("2026-10-26"), requestCount: 12, inputTokens: 900, estimatedCostMicros: BigInt(1234) },
        { connectionId: before.id, usageDate: new Date("2026-10-27"), requestCount: 99, outputTokens: 400 },
      ],
    });
    const log = await prisma.apiRequestLog.create({
      data: { userId: user.id, worldId: world.id, connectionId: before.id, model: "m", startedAt: new Date(), outcome: "HTTP_ERROR", httpStatus: 429 },
    });

    const { connection, created } = await saveGeminiApiKey(user.uid, newKey, material);
    const after = await rawRow(user.id);

    expect(created).toBe(false);
    expect(after.id).toBe(before.id);
    // 새 키로 바뀌고 이전 키는 더 이상 저장되어 있지 않다
    expect(await decryptGeminiApiKey(user.uid, material)).toBe(newKey);
    expect(Buffer.from(after.encryptedKey).equals(Buffer.from(before.encryptedKey))).toBe(false);
    expect(Buffer.from(after.keyIv).equals(Buffer.from(before.keyIv))).toBe(false);
    expect(after.keyFingerprint).toBe(keyFingerprint(newKey, material));
    expect(after.keyFingerprint).not.toBe(before.keyFingerprint);
    expect(connection.keyLast4).toBe(newKey.slice(-4));
    expect(await rowContainsPlaintext(user.id, oldKey)).toBe(false);
    expect(await rowContainsPlaintext(user.id, newKey)).toBe(false);
    // 참고: 교체 전 암호문 "사본"은 여전히 이전 키로만 풀린다(같은 행·같은 마스터 키).
    // 서비스는 DB에 이전 암호문을 남기지 않으므로 앱 경로로는 이전 키를 쓸 수 없다.
    // 이전 키 자체의 무효화는 사용자가 Google AI Studio에서 폐기해야 한다.
    expect(
      decryptSecret(
        { ciphertext: before.encryptedKey, iv: before.keyIv, authTag: before.keyAuthTag, keyVersion: before.encryptionKeyVersion },
        connectionAad(user.id, after.id),
        material,
      ),
    ).toBe(oldKey);

    // 유지: 사용량·한도·모델·로그 연결
    const usage = await prisma.apiUsageDaily.findMany({ where: { connectionId: after.id }, orderBy: { usageDate: "asc" } });
    expect(usage.map((u) => [u.requestCount, u.inputTokens, u.outputTokens, u.estimatedCostMicros])).toEqual([
      [12, 900, 0, BigInt(1234)],
      [99, 0, 400, BigInt(0)],
    ]);
    expect(after).toMatchObject({ dailyRequestLimit: 100, dailyTokenLimit: 50_000, defaultModel: "test-model-placeholder" });
    expect((await prisma.apiRequestLog.findUniqueOrThrow({ where: { id: log.id } })).connectionId).toBe(after.id);

    // 초기화: 백오프, 그리고 새 키는 미검증
    expect(after).toMatchObject({
      consecutiveFailures: 0,
      backoffLevel: 0,
      blockedUntil: null,
      blockReason: null,
      status: "UNVERIFIED",
      lastVerifiedAt: null,
      lastErrorCode: null,
    });
  });
});

describe("연결 삭제 (database.md §7)", () => {
  it("행을 지우고 사용량 집계는 연쇄 삭제, 요청 로그는 connectionId만 NULL", async () => {
    const user = await newUser("delete");
    await saveGeminiApiKey(user.uid, fakeGeminiKey("delete"), material);
    const { id } = await rawRow(user.id);
    await prisma.apiUsageDaily.create({ data: { connectionId: id, usageDate: new Date("2026-10-27"), requestCount: 3 } });
    const log = await prisma.apiRequestLog.create({
      data: { userId: user.id, connectionId: id, model: "m", startedAt: new Date(), outcome: "SUCCESS" },
    });

    expect(await deleteGeminiConnection(user.uid)).toBe(true);

    expect(await getGeminiConnection(user.uid)).toBeNull();
    expect(await decryptGeminiApiKey(user.uid, material)).toBeNull();
    expect(await prisma.apiUsageDaily.count({ where: { connectionId: id } })).toBe(0);
    expect((await prisma.apiRequestLog.findUniqueOrThrow({ where: { id: log.id } })).connectionId).toBeNull();
    expect(await deleteGeminiConnection(user.uid)).toBe(false);
  });
});

describe("사용자 간 격리", () => {
  it("다른 사용자의 연결을 조회·교체·삭제할 수 없다", async () => {
    const a = await newUser("iso-a");
    const b = await newUser("iso-b");
    const keyA = fakeGeminiKey("iso-a");
    await saveGeminiApiKey(a.uid, keyA, material);
    const rowA = await rawRow(a.id);

    expect(await getGeminiConnection(b.uid)).toBeNull();
    expect(await decryptGeminiApiKey(b.uid, material)).toBeNull();
    expect(await deleteGeminiConnection(b.uid)).toBe(false);

    const { created } = await saveGeminiApiKey(b.uid, fakeGeminiKey("iso-b"), material);
    expect(created).toBe(true);
    expect((await rawRow(b.id)).id).not.toBe(rowA.id);

    expect(await deleteGeminiConnection(b.uid)).toBe(true);
    const stillA = await rawRow(a.id);
    expect(stillA.id).toBe(rowA.id);
    expect(Buffer.from(stillA.encryptedKey).equals(Buffer.from(rowA.encryptedKey))).toBe(true);
    expect(await decryptGeminiApiKey(a.uid, material)).toBe(keyA);
  });
});

describe("동시 등록 — Provider별 UNIQUE 유지", () => {
  it("같은 사용자가 동시에 10번 등록해도 연결은 1개이고, 저장된 키·지문·last4가 서로 일치한다", async () => {
    const user = await newUser("concurrent");
    const keys = Array.from({ length: 10 }, (_, i) => fakeGeminiKey(`concurrent${i}`));

    const results = await Promise.all(keys.map((k) => saveGeminiApiKey(user.uid, k, material)));

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await prisma.aiProviderConnection.count({ where: { userId: user.id } })).toBe(1);
    const stored = await decryptGeminiApiKey(user.uid, material);
    expect(keys).toContain(stored);
    const row = await rawRow(user.id);
    expect(row.keyFingerprint).toBe(keyFingerprint(stored!, material));
    expect(row.keyLast4).toBe(stored!.slice(-4));
  });

  it("서로 다른 사용자의 동시 등록은 각자 1개씩 만든다", async () => {
    const users = await Promise.all([newUser("par-1"), newUser("par-2"), newUser("par-3")]);
    await Promise.all(users.map((u) => saveGeminiApiKey(u.uid, fakeGeminiKey(u.id.slice(-6)), material)));
    for (const u of users) expect(await prisma.aiProviderConnection.count({ where: { userId: u.id } })).toBe(1);
  });
});
