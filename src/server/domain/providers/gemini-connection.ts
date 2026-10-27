import { randomUUID } from "node:crypto";
import {
  connectionAad,
  decryptSecret,
  encryptSecret,
  getProviderKeyMaterial,
  keyFingerprint,
  type ProviderKeyMaterial,
} from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import type { AuthenticatedUserId } from "@/server/domain/identity";

// Gemini BYOK 연결 관리 (architecture.md §8, database.md §3.2). 런타임 독립 모듈.
// - 연결은 항상 (userId, provider = GEMINI)로 찾는다. userId는 검증된 세션에서 온 값만 받는다.
// - 원문 키는 저장·반환·로그하지 않는다. 암호문·IV·태그·지문도 조회 결과(DTO)에 담지 않는다.

const PROVIDER = "GEMINI" as const;

/** 클라이언트에 반환해도 되는 필드만 고른다 (화이트리스트). */
const connectionViewSelect = {
  provider: true,
  status: true,
  keyLast4: true,
  defaultModel: true,
  lastVerifiedAt: true,
  lastErrorCode: true,
  dailyRequestLimit: true,
  dailyTokenLimit: true,
  blockedUntil: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type GeminiConnectionView = {
  provider: "GEMINI";
  status: "UNVERIFIED" | "ACTIVE" | "INVALID";
  keyLast4: string;
  defaultModel: string | null;
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  dailyRequestLimit: number | null;
  dailyTokenLimit: number | null;
  blockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const byUser = (userId: AuthenticatedUserId) => ({ userId_provider: { userId, provider: PROVIDER } });

export async function getGeminiConnection(userId: AuthenticatedUserId): Promise<GeminiConnectionView | null> {
  return prisma.aiProviderConnection.findUnique({ where: byUser(userId), select: connectionViewSelect });
}

/**
 * 키 등록 또는 교체. 사용자 행을 잠가 같은 사용자의 동시 요청을 직렬화한다 ((userId, provider) UNIQUE가 2차 방어).
 * - 신규: defaultModel = null, status = UNVERIFIED (실제 키 검증은 Phase 3-2)
 * - 교체(D8): 같은 행의 키 필드만 바꾸고 서킷 브레이커만 초기화한다. 일일 한도·ApiUsageDaily·defaultModel은 유지한다.
 *   새 키는 아직 검증 전이므로 status = UNVERIFIED, 검증 시각·오류 코드를 비운다.
 */
export async function saveGeminiApiKey(
  userId: AuthenticatedUserId,
  apiKey: string,
  material: ProviderKeyMaterial = getProviderKeyMaterial(),
): Promise<{ connection: GeminiConnectionView; created: boolean }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "user" WHERE id = ${userId} FOR UPDATE`;
    const existing = await tx.aiProviderConnection.findUnique({ where: byUser(userId), select: { id: true } });
    const connectionId = existing?.id ?? randomUUID();

    const encrypted = encryptSecret(apiKey, connectionAad(userId, connectionId), material);
    const keyFields = {
      encryptedKey: encrypted.ciphertext,
      keyIv: encrypted.iv,
      keyAuthTag: encrypted.authTag,
      encryptionKeyVersion: encrypted.keyVersion,
      keyLast4: apiKey.slice(-4),
      keyFingerprint: keyFingerprint(apiKey, material),
      status: "UNVERIFIED" as const,
      lastVerifiedAt: null,
      lastErrorCode: null,
    };

    if (existing) {
      const connection = await tx.aiProviderConnection.update({
        where: { id: existing.id },
        data: {
          ...keyFields,
          // 백오프(서킷 브레이커)만 초기화 (D8)
          consecutiveFailures: 0,
          backoffLevel: 0,
          blockedUntil: null,
          blockReason: null,
        },
        select: connectionViewSelect,
      });
      return { connection, created: false };
    }

    const connection = await tx.aiProviderConnection.create({
      data: { id: connectionId, userId, provider: PROVIDER, defaultModel: null, ...keyFields },
      select: connectionViewSelect,
    });
    return { connection, created: true };
  });
}

/** 연결 삭제. ApiUsageDaily는 Cascade로 삭제, ApiRequestLog.connectionId는 SetNull (database.md §7). */
export async function deleteGeminiConnection(userId: AuthenticatedUserId): Promise<boolean> {
  const { count } = await prisma.aiProviderConnection.deleteMany({ where: { userId, provider: PROVIDER } });
  return count > 0;
}

/**
 * 저장된 키 원문을 복호화한다. LLM 호출 직전에만 쓰고 결과를 저장·로그하지 않는다 (architecture.md §8.1).
 * 연결이 없으면 null. 복호화 실패는 DecryptionError.
 */
export async function decryptGeminiApiKey(
  userId: AuthenticatedUserId,
  material: ProviderKeyMaterial = getProviderKeyMaterial(),
): Promise<string | null> {
  const row = await prisma.aiProviderConnection.findUnique({
    where: byUser(userId),
    select: { id: true, encryptedKey: true, keyIv: true, keyAuthTag: true, encryptionKeyVersion: true },
  });
  if (!row) return null;
  return decryptSecret(
    { ciphertext: row.encryptedKey, iv: row.keyIv, authTag: row.keyAuthTag, keyVersion: row.encryptionKeyVersion },
    connectionAad(userId, row.id),
    material,
  );
}
