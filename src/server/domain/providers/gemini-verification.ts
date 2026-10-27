import { PROVIDER_CHECK_RATE_LIMIT } from "../../../../config/limits";
import {
  connectionAad,
  decryptSecret,
  getProviderKeyMaterial,
  type ProviderKeyMaterial,
} from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { AppError, NotFoundError } from "@/server/domain/errors";
import type { AuthenticatedUserId } from "@/server/domain/identity";
import { getGeminiKeyClient } from "@/server/llm";
import { GeminiCallError, type GeminiCallRecord, type GeminiErrorKind, type GeminiKeyClient } from "@/server/llm/gemini/client";
import { isSelectableGeminiModel, selectableModels, type SelectableModel } from "@/server/llm/gemini/models";
import { getGeminiConnection, type GeminiConnectionView } from "./gemini-connection";

// Gemini 키 검증·모델 목록·모델 선택 (architecture.md §8.2). 런타임 독립.
// - 외부 호출은 사용자가 명시적으로 요청한 경우에만 한다 (검증 / 목록 새로고침 / 모델 선택)
// - 자동 재시도 없음. 호출마다 ApiRequestLog에 기록하고, 그 기록으로 사용자별 호출 한도를 건다
// - 같은 연결·같은 키의 동시 요청은 하나의 외부 호출로 합친다 (중복 방어)
// - 결과는 키 지문으로 펜싱한다: 호출 중 키가 교체되면 이전 키의 결과를 반영하지 않는다

type Deps = { client?: GeminiKeyClient; material?: ProviderKeyMaterial; now?: () => Date };

export const GEMINI_ERROR_MESSAGES: Record<GeminiErrorKind | "KEY_CHANGED", string> = {
  KEY_INVALID: "API 키가 유효하지 않습니다. Google AI Studio에서 키를 확인한 뒤 다시 등록하세요.",
  PERMISSION_DENIED: "이 키로는 Gemini API를 사용할 권한이 없습니다(권한·지역 제한). Google AI Studio 설정을 확인하세요.",
  // 429는 일시적 초과인지, 해당 모델 할당량이 없는지 단정하지 않는다
  QUOTA_EXCEEDED: "Gemini API가 할당량 제한으로 요청을 거부했습니다. 나중에 다시 시도하거나 다른 모델을 선택하세요.",
  MODEL_NOT_FOUND: "이 모델을 찾을 수 없습니다. 모델 목록을 새로고침한 뒤 다른 모델을 선택하세요.",
  BAD_REQUEST: "Gemini API가 요청을 거부했습니다.",
  UPSTREAM_ERROR: "Gemini API에 일시적인 오류가 있습니다. 잠시 후 다시 시도하세요.",
  TIMEOUT: "Gemini API 응답이 지연되었습니다. 잠시 후 다시 시도하세요.",
  NETWORK_ERROR: "Gemini API에 연결하지 못했습니다. 네트워크 상태를 확인하세요.",
  INCOMPLETE_RESPONSE: "모델이 응답을 끝까지 생성하지 못했습니다(빈 응답·출력 한도 도달·차단 등). 다른 모델을 선택하거나 나중에 다시 시도하세요.",
  KEY_CHANGED: "검증하는 동안 API 키가 교체되었습니다. 새 키로 다시 검증하세요.",
};

/** 키 자체가 쓸 수 없다고 판단되는 오류 → 연결 INVALID */
const KEY_FATAL: ReadonlySet<GeminiErrorKind> = new Set(["KEY_INVALID", "PERMISSION_DENIED"]);

const GEMINI_HTTP_STATUS: Record<GeminiErrorKind, number> = {
  KEY_INVALID: 422,
  PERMISSION_DENIED: 422,
  MODEL_NOT_FOUND: 422,
  BAD_REQUEST: 422,
  QUOTA_EXCEEDED: 429,
  UPSTREAM_ERROR: 502,
  TIMEOUT: 504,
  NETWORK_ERROR: 504,
  INCOMPLETE_RESPONSE: 422,
};

export class GeminiRequestError extends AppError {
  constructor(readonly kind: GeminiErrorKind) {
    super(GEMINI_HTTP_STATUS[kind], `GEMINI_${kind}`, GEMINI_ERROR_MESSAGES[kind]);
  }
}

export class ProviderRateLimitError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, "RATE_LIMITED", `Gemini 확인 요청이 너무 많습니다. ${retryAfterSeconds}초 후 다시 시도하세요.`);
  }
}

export class ConnectionNotReadyError extends AppError {
  constructor(code: "GEMINI_NOT_CONNECTED" | "GEMINI_NOT_VERIFIED" | "GEMINI_MODEL_NOT_SELECTED") {
    const message = {
      GEMINI_NOT_CONNECTED: "Gemini API 키가 등록되어 있지 않습니다.",
      GEMINI_NOT_VERIFIED: "Gemini API 키를 먼저 검증하세요.",
      GEMINI_MODEL_NOT_SELECTED: "사용할 Gemini 모델을 먼저 선택하세요.",
    }[code];
    super(409, code, message);
  }
}

/**
 * 모델 정보 조회(models.get)는 성공했지만 최소 생성 요청이 거부됨 (404·403·400).
 * 원인(신규 프로젝트 제한, 권한, 모델 정책 등)은 응답만으로 단정할 수 없으므로 하나의 일반 오류로 처리한다.
 */
export class ModelUnavailableError extends AppError {
  constructor() {
    super(422, "GEMINI_MODEL_UNAVAILABLE", "이 모델로 생성 요청을 보낼 수 없었습니다. 다른 모델을 선택하거나 나중에 다시 시도하세요.");
  }
}

export class UnsupportedModelError extends AppError {
  constructor() {
    super(422, "GEMINI_MODEL_NOT_SUPPORTED", "이 모델은 대화 생성에 사용할 수 없습니다. 목록에서 다른 모델을 선택하세요.");
  }
}

// ── 호출 기록과 한도 ─────────────────────────────

/** 세계관·Run에 속하지 않는 호출 = 연결 관리용 호출 */
const managementCalls = (userId: string, since: Date) => ({ userId, worldId: null, runId: null, createdAt: { gte: since } });

async function assertWithinRateLimit(userId: AuthenticatedUserId, needed: number, now: Date): Promise<void> {
  const since = new Date(now.getTime() - PROVIDER_CHECK_RATE_LIMIT.windowMs);
  const recent = await prisma.apiRequestLog.findMany({
    where: managementCalls(userId, since),
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (recent.length + needed <= PROVIDER_CHECK_RATE_LIMIT.maxCalls) return;
  const freeAt = recent[recent.length + needed - PROVIDER_CHECK_RATE_LIMIT.maxCalls - 1]!.createdAt.getTime() + PROVIDER_CHECK_RATE_LIMIT.windowMs;
  throw new ProviderRateLimitError(Math.max(1, Math.ceil((freeAt - now.getTime()) / 1000)));
}

/** Gemini로 실제 전송된 요청만 기록한다 (= 호출 한도 집계 단위). 로컬에서 거부된 시도는 제외. */
async function writeCallLogs(userId: string, connectionId: string, records: GeminiCallRecord[]): Promise<void> {
  const sent = records.filter((r) => r.sent);
  if (sent.length === 0) return;
  await prisma.apiRequestLog.createMany({
    data: sent.map((r) => ({
      userId,
      connectionId,
      model: r.model ?? `(${r.operation})`,
      startedAt: r.startedAt,
      latencyMs: r.latencyMs,
      httpStatus: r.httpStatus,
      // HTTP 200이지만 완료되지 않은 생성은 VALIDATION_ERROR (architecture.md §12)
      outcome:
        r.errorKind === null
          ? "SUCCESS"
          : r.errorKind === "INCOMPLETE_RESPONSE"
            ? "VALIDATION_ERROR"
            : r.errorKind === "NETWORK_ERROR" || (r.errorKind === "TIMEOUT" && r.httpStatus === null)
              ? "NETWORK_ERROR"
              : "HTTP_ERROR",
      errorCode: r.errorKind,
      errorMessage: r.upstreamDetail, // 안전한 열거형 토큰만 (safeUpstreamDetail)
      inputTokens: r.usage?.inputTokens ?? null,
      outputTokens: r.usage?.outputTokens ?? null,
      thoughtTokens: r.usage?.thoughtTokens ?? null,
    })),
  });
}

// ── 키 로드와 동시 요청 병합 ─────────────────────

type KeyContext = { connectionId: string; fingerprint: string; status: string; defaultModel: string | null; apiKey: string };

async function loadKey(userId: AuthenticatedUserId, material: ProviderKeyMaterial): Promise<KeyContext> {
  const row = await prisma.aiProviderConnection.findUnique({
    where: { userId_provider: { userId, provider: "GEMINI" } },
    select: { id: true, keyFingerprint: true, status: true, defaultModel: true, encryptedKey: true, keyIv: true, keyAuthTag: true, encryptionKeyVersion: true },
  });
  if (!row) throw new NotFoundError();
  const apiKey = decryptSecret(
    { ciphertext: row.encryptedKey, iv: row.keyIv, authTag: row.keyAuthTag, keyVersion: row.encryptionKeyVersion },
    connectionAad(userId, row.id),
    material,
  );
  return { connectionId: row.id, fingerprint: row.keyFingerprint, status: row.status, defaultModel: row.defaultModel, apiKey };
}

const inFlight = new Map<string, Promise<unknown>>();

/** 같은 키에 대한 같은 작업이 진행 중이면 그 결과를 공유한다 (프로세스 단위). */
function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** 외부 호출을 실행하고, 성공·실패와 관계없이 호출 기록을 남긴다. */
async function withCallLog<T>(userId: string, ctx: KeyContext, run: (onCall: (r: GeminiCallRecord) => void) => Promise<T>): Promise<T> {
  const records: GeminiCallRecord[] = [];
  try {
    return await run((r) => records.push(r));
  } finally {
    await writeCallLogs(userId, ctx.connectionId, records);
  }
}

/** 키 지문이 그대로일 때만 상태를 바꾼다. 바뀌었으면 false (호출 중 키 교체). */
async function updateIfSameKey(ctx: KeyContext, data: Parameters<typeof prisma.aiProviderConnection.updateMany>[0]["data"], extra: { status?: "ACTIVE" } = {}): Promise<boolean> {
  const { count } = await prisma.aiProviderConnection.updateMany({
    where: { id: ctx.connectionId, keyFingerprint: ctx.fingerprint, ...extra },
    data,
  });
  return count === 1;
}

async function markFailure(ctx: KeyContext, kind: GeminiErrorKind): Promise<void> {
  await updateIfSameKey(ctx, KEY_FATAL.has(kind) ? { status: "INVALID", lastErrorCode: kind } : { lastErrorCode: kind });
}

async function currentView(userId: AuthenticatedUserId): Promise<GeminiConnectionView> {
  const view = await getGeminiConnection(userId);
  if (!view) throw new NotFoundError();
  return view;
}

// ── 키 검증 ──────────────────────────────────────

export type VerificationResult = {
  verification: { ok: true } | { ok: false; code: GeminiErrorKind | "KEY_CHANGED"; message: string };
  connection: GeminiConnectionView;
  /** 검증 성공 시 선택 가능한 모델. 실패 시 [] */
  models: SelectableModel[];
  /** 기존 defaultModel을 새 키로 쓸 수 없어 비웠다 → 다시 선택해야 함 */
  modelReselectRequired: boolean;
};

/**
 * 저장된 키로 모델 목록을 조회해 키를 검증한다 (외부 호출: models.list 1회, 페이지가 더 있으면 추가).
 * 성공: ACTIVE, lastVerifiedAt 갱신, 기존 defaultModel이 목록에 없으면 비운다.
 * 키 오류(KEY_INVALID·PERMISSION_DENIED): INVALID. 그 밖의 오류: 상태 유지, lastErrorCode만 기록.
 */
export async function verifyGeminiConnection(userId: AuthenticatedUserId, deps: Deps = {}): Promise<VerificationResult> {
  const material = deps.material ?? getProviderKeyMaterial();
  const ctx = await loadKey(userId, material);
  return singleFlight(`verify:${ctx.connectionId}:${ctx.fingerprint}`, async () => {
    const now = deps.now?.() ?? new Date();
    await assertWithinRateLimit(userId, 1, now);
    const client = deps.client ?? getGeminiKeyClient();

    let models: SelectableModel[];
    try {
      models = selectableModels(await withCallLog(userId, ctx, (onCall) => client.listModels(ctx.apiKey, onCall)));
    } catch (error) {
      if (!(error instanceof GeminiCallError)) throw error;
      await markFailure(ctx, error.kind);
      return {
        verification: { ok: false, code: error.kind, message: GEMINI_ERROR_MESSAGES[error.kind] },
        connection: await currentView(userId),
        models: [],
        modelReselectRequired: false,
      };
    }

    const keepModel = ctx.defaultModel !== null && models.some((m) => m.id === ctx.defaultModel);
    const applied = await updateIfSameKey(ctx, {
      status: "ACTIVE",
      lastVerifiedAt: now,
      lastErrorCode: null,
      ...(keepModel ? {} : { defaultModel: null }),
    });
    if (!applied) {
      return { verification: { ok: false, code: "KEY_CHANGED", message: GEMINI_ERROR_MESSAGES.KEY_CHANGED }, connection: await currentView(userId), models: [], modelReselectRequired: false };
    }
    return { verification: { ok: true }, connection: await currentView(userId), models, modelReselectRequired: ctx.defaultModel !== null && !keepModel };
  });
}

// ── 모델 목록 (새로고침) ─────────────────────────

/** 검증된 연결의 선택 가능 모델 목록 (외부 호출: models.list 1회). */
export async function listGeminiModels(userId: AuthenticatedUserId, deps: Deps = {}): Promise<SelectableModel[]> {
  const material = deps.material ?? getProviderKeyMaterial();
  const ctx = await loadKey(userId, material);
  if (ctx.status !== "ACTIVE") throw new ConnectionNotReadyError("GEMINI_NOT_VERIFIED");
  return singleFlight(`list:${ctx.connectionId}:${ctx.fingerprint}`, async () => {
    await assertWithinRateLimit(userId, 1, deps.now?.() ?? new Date());
    const client = deps.client ?? getGeminiKeyClient();
    try {
      return selectableModels(await withCallLog(userId, ctx, (onCall) => client.listModels(ctx.apiKey, onCall)));
    } catch (error) {
      if (!(error instanceof GeminiCallError)) throw error;
      await markFailure(ctx, error.kind);
      throw new GeminiRequestError(error.kind);
    }
  });
}

// ── 모델 선택 ────────────────────────────────────

/**
 * 모델을 선택한다. 검증된(ACTIVE) 연결만 가능하다.
 * 외부 호출 2회: models.get(존재·지원 기능 확인) → generateContent 최소 요청(실제 사용 가능 확인, 출력 토큰 상한 있음).
 * 두 확인을 모두 통과해야 defaultModel을 바꾼다.
 */
export async function selectGeminiModel(userId: AuthenticatedUserId, modelId: string, deps: Deps = {}): Promise<GeminiConnectionView> {
  const material = deps.material ?? getProviderKeyMaterial();
  const ctx = await loadKey(userId, material);
  if (ctx.status !== "ACTIVE") throw new ConnectionNotReadyError("GEMINI_NOT_VERIFIED");
  return singleFlight(`select:${ctx.connectionId}:${ctx.fingerprint}:${modelId}`, async () => {
    await assertWithinRateLimit(userId, 2, deps.now?.() ?? new Date());
    const client = deps.client ?? getGeminiKeyClient();
    const progress: { stage: "get" | "probe" } = { stage: "get" };
    try {
      await withCallLog(userId, ctx, async (onCall) => {
        const info = await client.getModel(ctx.apiKey, modelId, onCall);
        if (!isSelectableGeminiModel(info)) throw new UnsupportedModelError();
        progress.stage = "probe";
        await client.probeModel(ctx.apiKey, modelId, onCall);
      });
    } catch (error) {
      if (!(error instanceof GeminiCallError)) throw error;
      // 키 자체가 무효로 판정된 경우에만 연결을 INVALID로 바꾼다. 403 등은 모델 단위 문제일 수 있어 연결 상태를 유지한다
      if (error.kind === "KEY_INVALID") await markFailure(ctx, error.kind);
      if (progress.stage === "probe" && (error.kind === "MODEL_NOT_FOUND" || error.kind === "PERMISSION_DENIED" || error.kind === "BAD_REQUEST")) {
        throw new ModelUnavailableError();
      }
      throw new GeminiRequestError(error.kind);
    }
    const applied = await updateIfSameKey(ctx, { defaultModel: modelId, lastErrorCode: null }, { status: "ACTIVE" });
    if (!applied) throw new ConnectionNotReadyError("GEMINI_NOT_VERIFIED");
    return currentView(userId);
  });
}

// ── 사용 가능 여부 (후속 LLM 호출의 관문) ─────────

/** Gemini를 호출하기 전에 반드시 통과해야 한다: 연결 있음 + ACTIVE + 모델 선택됨. 외부 호출 없음. */
export async function requireUsableGeminiConnection(userId: AuthenticatedUserId): Promise<{ connectionId: string; modelId: string }> {
  const row = await prisma.aiProviderConnection.findUnique({
    where: { userId_provider: { userId, provider: "GEMINI" } },
    select: { id: true, status: true, defaultModel: true },
  });
  if (!row) throw new ConnectionNotReadyError("GEMINI_NOT_CONNECTED");
  if (row.status !== "ACTIVE") throw new ConnectionNotReadyError("GEMINI_NOT_VERIFIED");
  if (!row.defaultModel) throw new ConnectionNotReadyError("GEMINI_MODEL_NOT_SELECTED");
  return { connectionId: row.id, modelId: row.defaultModel };
}
