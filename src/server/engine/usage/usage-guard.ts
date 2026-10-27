import { PROVIDER_CHECK_RATE_LIMIT, USAGE_PENDING_STALE_MS } from "../../../../config/limits";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { NotFoundError } from "@/server/domain/errors";
import type { GeminiCallRecord, GeminiRequestInfo, GeminiRequestMeter } from "@/server/llm/gemini/client";
import { logServerError } from "@/server/logging/log";
import { afterResult, gate, type BreakerState } from "./breaker";
import { CircuitOpenError, ConnectionNotReadyError, KeyChangedError, ProviderRateLimitError, UsageLimitError } from "./errors";
import { kstDate, nextKstMidnight } from "./kst";
import { consumesTokens, failureClassOf, outcomeOf, tokenTotals, usageStatusOf } from "./metering";

// UsageGuard — 모든 Gemini HTTP 요청의 단일 관문 (architecture.md §6.1 MeteredLlmClient, §8.3). 런타임 독립.
//
// 요청 1건마다:
//   1) 예약(전송 직전, 한 트랜잭션): [관리용이면 사용자 행 잠금] → 연결 행 잠금 → 키 지문 확인 → 결과 유실 정리
//      → [시뮬레이션: 연결 ACTIVE·서킷 브레이커] / [관리용: 사용자당 10분 10회] → 일일 한도(KST) → requestCount + 1
//      → ApiRequestLog(PENDING) INSERT. 하나라도 걸리면 요청을 보내지 않는다.
//   2) 전송 (자동 재시도 없음)
//   3) 정산(응답 후, 한 트랜잭션): 연결 행 잠금 → 로그 확정 → 일일 토큰·미계측 수 누적 → Run 카운터 → 브레이커·키 상태
//
// 잠금은 DB 행 잠금이므로 Next.js 인스턴스·Worker가 여럿이어도 같은 연결의 예약은 직렬화된다.
// 잠금 순서는 user → AiProviderConnection (키 등록·교체와 같음).
// 일일 집계(ApiUsageDaily)는 호출 기록(ApiRequestLog)과 같은 트랜잭션에서 바뀐다:
//   requestCount = 그 KST 날짜에 생성된 로그 행 수, 토큰 합 = 로그 토큰 합, unmeteredRequestCount = MISSING·UNKNOWN 행 수.

export type UsageTarget = {
  userId: string;
  connectionId: string;
  /** 키를 읽은 시점의 지문. 예약 시점에 다르면 요청하지 않는다 */
  keyFingerprint: string;
};

export type UsagePurpose =
  /** 연결 관리용(키 검증·모델 목록·모델 확인): 사용자당 10분 10회, 서킷 브레이커는 적용·갱신하지 않는다 */
  | { kind: "MANAGEMENT"; /** 첫 요청 예약 때 남아 있어야 하는 호출 횟수 (모델 선택 = 2) */ requiredCapacity?: number }
  /** 시뮬레이션 호출: 연결 ACTIVE 필수, 서킷 브레이커 적용, Run별 사용량 누적 */
  | { kind: "SIMULATION"; worldId: string; runId?: string | null; attemptId?: string | null; callIndex?: number };

export type UsageGuardOptions = { now?: () => Date };

type Reservation = { logId: string; usageDate: Date; trial: boolean };

const breakerSelect = { consecutiveFailures: true, backoffLevel: true, blockedUntil: true, blockReason: true } as const;

const secondsUntil = (at: Date, now: Date) => Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000));

/**
 * 요청마다 예약·정산하는 meter를 만든다. GeminiKeyClient 메서드에 넘긴다.
 * meter 하나는 한 작업(예: 모델 선택 = 조회 + 생성)의 요청들에 쓴다.
 */
export function createUsageMeter(target: UsageTarget, purpose: UsagePurpose, options: UsageGuardOptions = {}): GeminiRequestMeter {
  const now = options.now ?? (() => new Date());
  let first = true;
  return async (request) => {
    const capacity = purpose.kind === "MANAGEMENT" && first ? Math.max(1, purpose.requiredCapacity ?? 1) : 1;
    first = false;
    const reservation = await reserve(target, purpose, request, capacity, now());
    let settled = false;
    return async (record) => {
      if (settled) return;
      settled = true;
      try {
        await settle(target, purpose, reservation, record, now());
      } catch (error) {
        // 정산 실패가 호출 결과를 가리지 않게 한다. 남은 PENDING 행은 다음 예약 때 결과 유실로 정리된다
        logServerError("usage.settle", error);
      }
    };
  };
}

// ── 예약 ─────────────────────────────────────────

async function reserve(target: UsageTarget, purpose: UsagePurpose, request: GeminiRequestInfo, capacity: number, now: Date): Promise<Reservation> {
  const { userId, connectionId } = target;
  return prisma.$transaction(async (tx) => {
    if (purpose.kind === "MANAGEMENT") await tx.$queryRaw`SELECT 1 FROM "user" WHERE id = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT 1 FROM "AiProviderConnection" WHERE id = ${connectionId} AND "userId" = ${userId} FOR UPDATE`;
    const conn = await tx.aiProviderConnection.findFirst({
      where: { id: connectionId, userId },
      select: { keyFingerprint: true, status: true, dailyRequestLimit: true, dailyTokenLimit: true, ...breakerSelect },
    });
    if (!conn) throw new NotFoundError(); // 호출 준비 중 연결 삭제
    if (conn.keyFingerprint !== target.keyFingerprint) throw new KeyChangedError();

    await reconcileLostCalls(tx, connectionId, now);

    let trial = false;
    if (purpose.kind === "SIMULATION") {
      if (conn.status !== "ACTIVE") throw new ConnectionNotReadyError("GEMINI_NOT_VERIFIED");
      const decision = gate(conn, now);
      if (!decision.allowed) throw new CircuitOpenError(decision.until, decision.reason, secondsUntil(decision.until, now));
      if (decision.trial) {
        trial = true;
        await tx.aiProviderConnection.update({ where: { id: connectionId }, data: decision.next });
      }
    } else {
      await assertManagementCapacity(tx, userId, capacity, now);
    }

    // 일일 한도 (KST 날짜). 예약과 정산에 같은 날짜를 쓴다
    const usageDate = kstDate(now);
    const today = await tx.apiUsageDaily.findUnique({ where: { connectionId_usageDate: { connectionId, usageDate } } });
    const resetsAt = nextKstMidnight(now);
    if (conn.dailyRequestLimit !== null && (today?.requestCount ?? 0) >= conn.dailyRequestLimit) {
      throw new UsageLimitError("REQUESTS", resetsAt, secondsUntil(resetsAt, now));
    }
    // 토큰은 응답 후에야 알 수 있으므로 누적값이 한도에 도달했으면 다음 생성 요청부터 막는다 (진행 중인 요청만큼 넘을 수 있음)
    const usedTokens = (today?.inputTokens ?? 0) + (today?.outputTokens ?? 0) + (today?.thoughtTokens ?? 0);
    if (consumesTokens(request.operation) && conn.dailyTokenLimit !== null && usedTokens >= conn.dailyTokenLimit) {
      throw new UsageLimitError("TOKENS", resetsAt, secondsUntil(resetsAt, now));
    }

    await tx.apiUsageDaily.upsert({
      where: { connectionId_usageDate: { connectionId, usageDate } },
      create: { connectionId, usageDate, requestCount: 1 },
      update: { requestCount: { increment: 1 } },
    });
    const scope = purpose.kind === "SIMULATION" ? purpose : null;
    const log = await tx.apiRequestLog.create({
      data: {
        userId,
        connectionId,
        worldId: scope?.worldId ?? null,
        runId: scope?.runId ?? null,
        attemptId: scope?.attemptId ?? null,
        callIndex: scope?.callIndex ?? 0,
        model: request.model ?? `(${request.operation})`,
        startedAt: now,
        createdAt: now, // 일일 집계 날짜(usageDate)와 같은 시각 기준
        outcome: "PENDING",
        // 토큰을 쓰지 않는 요청은 미리 확정. 생성 요청은 정산 때 정한다 (유실되면 UNKNOWN)
        usageStatus: consumesTokens(request.operation) ? null : "NOT_APPLICABLE",
      },
      select: { id: true },
    });
    return { logId: log.id, usageDate, trial };
  });
}

/** 사용자당 연결 관리용 호출 한도. 진행 중(PENDING)인 요청도 센다 → 동시 요청이 한도를 넘지 못한다 */
async function assertManagementCapacity(tx: Prisma.TransactionClient, userId: string, needed: number, now: Date): Promise<void> {
  const since = new Date(now.getTime() - PROVIDER_CHECK_RATE_LIMIT.windowMs);
  const recent = await tx.apiRequestLog.findMany({
    where: { userId, worldId: null, runId: null, createdAt: { gte: since } },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (recent.length + needed <= PROVIDER_CHECK_RATE_LIMIT.maxCalls) return;
  const index = Math.min(recent.length - 1, Math.max(0, recent.length + needed - PROVIDER_CHECK_RATE_LIMIT.maxCalls - 1));
  const freeAt = new Date(recent[index]!.createdAt.getTime() + PROVIDER_CHECK_RATE_LIMIT.windowMs);
  throw new ProviderRateLimitError(secondsUntil(freeAt, now));
}

/**
 * 예약 후 정산되지 않은 채 오래된 호출(프로세스 종료 등)을 결과 유실로 확정한다.
 * 요청은 이미 집계되어 있으므로 requestCount는 그대로 두고, 생성 요청이면 사용량 미확인(UNKNOWN)으로 센다.
 */
async function reconcileLostCalls(tx: Prisma.TransactionClient, connectionId: string, now: Date): Promise<void> {
  const lost = await tx.apiRequestLog.findMany({
    where: { connectionId, outcome: "PENDING", createdAt: { lt: new Date(now.getTime() - USAGE_PENDING_STALE_MS) } },
    select: { id: true, createdAt: true, usageStatus: true },
  });
  if (lost.length === 0) return;
  const generation = lost.filter((l) => l.usageStatus === null);
  await tx.apiRequestLog.updateMany({ where: { id: { in: lost.map((l) => l.id) } }, data: { outcome: "ABORTED", errorCode: "RESULT_LOST" } });
  if (generation.length === 0) return;
  await tx.apiRequestLog.updateMany({ where: { id: { in: generation.map((l) => l.id) } }, data: { usageStatus: "UNKNOWN" } });
  const perDate = new Map<number, number>();
  for (const l of generation) {
    const day = kstDate(l.createdAt).getTime();
    perDate.set(day, (perDate.get(day) ?? 0) + 1);
  }
  for (const [day, count] of perDate) {
    await tx.apiUsageDaily.updateMany({ where: { connectionId, usageDate: new Date(day) }, data: { unmeteredRequestCount: { increment: count } } });
  }
}

// ── 정산 ─────────────────────────────────────────

async function settle(target: UsageTarget, purpose: UsagePurpose, reservation: Reservation, record: GeminiCallRecord, now: Date): Promise<void> {
  const { connectionId } = target;
  const { logId, usageDate } = reservation;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "AiProviderConnection" WHERE id = ${connectionId} FOR UPDATE`;
    const daily = { connectionId, usageDate };

    if (!record.sent) {
      // 로컬에서 거부되어 Gemini로 나가지 않은 시도 → 예약을 되돌린다 (외부 호출로 세지 않음)
      const { count } = await tx.apiRequestLog.deleteMany({ where: { id: logId, outcome: "PENDING" } });
      if (count === 1) await tx.apiUsageDaily.updateMany({ where: { ...daily, requestCount: { gt: 0 } }, data: { requestCount: { decrement: 1 } } });
      if (reservation.trial) await updateBreaker(tx, target, (state) => afterResult(state, "REQUEST", now));
      return;
    }

    const usageStatus = usageStatusOf(record);
    const { count } = await tx.apiRequestLog.updateMany({
      where: { id: logId, outcome: "PENDING" },
      data: {
        startedAt: record.startedAt,
        latencyMs: record.latencyMs,
        httpStatus: record.httpStatus,
        outcome: outcomeOf(record),
        errorCode: record.errorKind,
        errorMessage: record.upstreamDetail, // 안전한 열거형 토큰만 (safeUpstreamDetail)
        inputTokens: record.usage?.inputTokens ?? null,
        outputTokens: record.usage?.outputTokens ?? null,
        thoughtTokens: record.usage?.thoughtTokens ?? null,
        usageStatus,
      },
    });
    // 이미 결과 유실로 정리된 행이면 집계를 두 번 바꾸지 않는다
    if (count === 0) return;

    const tokens = tokenTotals(record);
    const unmetered = usageStatus === "MISSING" || usageStatus === "UNKNOWN" ? 1 : 0;
    await tx.apiUsageDaily.updateMany({
      where: daily,
      data: {
        inputTokens: { increment: tokens.inputTokens },
        outputTokens: { increment: tokens.outputTokens },
        thoughtTokens: { increment: tokens.thoughtTokens },
        unmeteredRequestCount: { increment: unmetered },
      },
    });

    const failure = failureClassOf(record.errorKind);
    if (purpose.kind === "SIMULATION") {
      if (purpose.runId) {
        // Run(세션)별 사용량은 키 단위 집계와 별도로 누적한다 (D8). 성공·실패는 HTTP 호출 결과 기준
        await tx.simulationRun.updateMany({
          where: { id: purpose.runId, worldId: purpose.worldId },
          data: {
            requestCount: { increment: 1 },
            successCount: { increment: failure === "NONE" ? 1 : 0 },
            failureCount: { increment: failure === "NONE" ? 0 : 1 },
            inputTokens: { increment: tokens.inputTokens },
            outputTokens: { increment: tokens.outputTokens },
            thoughtTokens: { increment: tokens.thoughtTokens },
          },
        });
      }
      await updateBreaker(tx, target, (state) => afterResult(state, failure, now, record.retryAfterMs));
    }
    // 키 무효는 영구 오류: 키를 교체할 때까지 연결을 INVALID로 막는다 (관리용 호출도 같음)
    if (failure === "KEY") {
      await tx.aiProviderConnection.updateMany({ where: { id: connectionId, keyFingerprint: target.keyFingerprint }, data: { status: "INVALID", lastErrorCode: "KEY_INVALID" } });
    }
  });
}

/** 같은 키일 때만 브레이커를 바꾼다. 키를 교체하면 브레이커가 초기화되므로 이전 키의 결과를 반영하지 않는다 (D8). */
async function updateBreaker(tx: Prisma.TransactionClient, target: UsageTarget, next: (state: BreakerState) => BreakerState): Promise<void> {
  const current = await tx.aiProviderConnection.findFirst({ where: { id: target.connectionId, keyFingerprint: target.keyFingerprint }, select: breakerSelect });
  if (!current) return;
  const state = next(current);
  if (
    state.consecutiveFailures === current.consecutiveFailures &&
    state.backoffLevel === current.backoffLevel &&
    state.blockedUntil?.getTime() === current.blockedUntil?.getTime() &&
    state.blockReason === current.blockReason
  ) {
    return;
  }
  await tx.aiProviderConnection.update({ where: { id: target.connectionId }, data: state });
}
