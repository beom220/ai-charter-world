import { randomUUID } from "node:crypto";
import { RUNNER_LEASE_RENEW_MS, RUNNER_LEASE_TTL_MS, RUNNER_POLL_INTERVAL_MS, SCENE_IN_FLIGHT_STALE_MS } from "../../../../config/limits";
import type { Prisma, StatusReason } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { ConflictError, NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId, type AuthenticatedUserId } from "@/server/domain/identity";
import { ConnectionNotReadyError, GeminiRequestError } from "@/server/domain/providers/gemini-verification";
import { prepareScene, runSceneAttempt, SceneValidationFailedError, settingsUnchanged, type SceneDeps } from "@/server/domain/scenes/generate-scene";
import { claimAutoEvent, type AutoEventClaim } from "@/server/domain/scenes/scene-world";
import { claimUserEvent, releaseUserEventClaim, type UserEventClaim } from "@/server/domain/events/user-events";

type PreparedScene = Awaited<ReturnType<typeof prepareScene>>;
import { reconcileClientHold } from "@/server/domain/simulation/client-hold";
import { publishRuntimeStatus, settlePausing } from "@/server/domain/simulation/control";
import { settleWorldClock, touchWorldClock } from "@/server/domain/simulation/world-clock";
import { CircuitOpenError, KeyChangedError, UsageLimitError } from "@/server/engine/usage/errors";
import { notifyWorld, publishEvents } from "@/server/events/event-bus";
import { logServerError } from "@/server/logging/log";
import { nextSceneAfterBackoff, nextSceneAfterCommit, nextSceneAfterFailure } from "./schedule";

// 세계관 1개의 Runner 한 단계 (architecture.md §6.3·§7.4, Phase 5-4-2). 런타임 독립. 상태의 기준은 DB다.
//   1) lease 획득·갱신 (조건부 UPDATE 1건: RUNNING·PAUSING이고 비었거나 내 것이거나 만료) — 실패하면 종료
//   2) 남아 있는 진행 중 시도(다른 프로세스가 남김)는 결과가 불확실하므로 재시도하지 않는다.
//      요청 타임아웃(60초)보다 긴 SCENE_IN_FLIGHT_STALE_MS가 지날 때까지 새 호출을 하지 않고, 지나면 버린다
//   3) PAUSING이면 PAUSED로 마무리하고 종료. RUNNING이면 nextSceneAt까지 대기
//   4) 참가자·연결·키 준비 → 시도 기록(조건부 UPDATE: RUNNING + 같은 Run + lease 소유 + 진행 중 없음 + 예정 시각 도달)
//      → 요청 직전 재검증 → UsageGuard 예약 → Gemini 1회 → 검증 → 펜싱 커밋(stateVersion·Run·lease·attemptId) + outbox
//   5) 진행 중 표시 해제 + 다음 예약(nextSceneAt) 또는 PAUSED(USAGE_LIMIT·KEY_INVALID) + scene.failed·runtime.status, 한 트랜잭션
// SSE 연결 보류(Phase 5-4-3): RUNNING이면 매 단계와 호출 중 heartbeat마다 reconcileClientHold로 보류 시작·해제·만료를 처리한다.
//   보류 중에는 시도를 기록하지 않고(조건: clientHoldSince IS NULL), 요청 직전 재검증도 같은 조건을 본다.
// 이벤트: 시도 기록과 같은 트랜잭션에서 scene.started, 커밋과 함께 scene.committed, 실패 확정과 함께 scene.failed.
// DB 트랜잭션은 Gemini 요청 동안 열어 두지 않는다. 실패한 장면은 다시 보내지 않는다(다음 장면은 새 attemptId).

export type RunnerContext = {
  /** lease 소유자 ID (hostname:pid:bootId) */
  owner: string;
  deps?: SceneDeps;
  /** 이 Runner의 연속 장면 실패 수 (프로세스 메모리, 재시작하면 0부터) */
  state: { failures: number };
};

export type TickResult = { kind: "exit" } | { kind: "wait"; ms: number };

const EXIT: TickResult = { kind: "exit" };
/** 대기 중에도 RUNNER_POLL_INTERVAL_MS마다 상태를 다시 읽는다 (신호 유실 대비) */
const waitFor = (ms: number): TickResult => ({ kind: "wait", ms: Math.max(0, Math.min(ms, RUNNER_POLL_INTERVAL_MS)) });

/** 요청 직전 재검증에서 이번 시도가 더 이상 유효하지 않음 (일시정지·종료·lease 상실). 요청을 보내지 않는다 */
class AttemptPreemptedError extends Error {
  override name = "AttemptPreemptedError";
}

/** scene.failed의 공개 오류 코드 (오류 원문·키·프롬프트 없음) */
export type SceneFailureCode =
  | "VALIDATION_ERROR"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "USAGE_LIMIT"
  | "BACKOFF"
  | "KEY_INVALID"
  | "STALE"
  | "ABORTED"
  | "RESULT_LOST"
  | "INTERNAL_ERROR";

type Outcome =
  | { kind: "committed"; turns: number }
  | { kind: "failed"; code: SceneFailureCode }
  | { kind: "backoff"; until: Date; code: SceneFailureCode }
  | { kind: "pause"; reason: StatusReason; code: SceneFailureCode }
  /** 외부 요청 전에 멈춤(상태 변경·키 교체). 실패로 세지 않고 예약도 바꾸지 않는다 */
  | { kind: "skipped"; code: SceneFailureCode };

const KEY_FATAL = new Set(["KEY_INVALID", "PERMISSION_DENIED"]);

export async function runWorldTick(worldId: string, ctx: RunnerContext): Promise<TickResult> {
  const now = ctx.deps?.now ?? (() => new Date());
  const at = now();
  if (!(await acquireLease(worldId, ctx.owner, at))) return EXIT; // 실행 상태 아님·삭제됨·다른 Runner 소유

  const rt = await prisma.simulationRuntime.findUnique({
    where: { worldId },
    select: {
      status: true,
      currentRunId: true,
      inFlightAttemptId: true,
      inFlightStartedAt: true,
      nextSceneAt: true,
      world: { select: { ownerId: true } },
    },
  });
  if (!rt) return EXIT;

  if (rt.status === "RUNNING") {
    const hold = await reconcileClientHold(worldId, at);
    if (hold === "paused") return waitFor(0); // PAUSED면 다음 단계에서 종료, PAUSING이면 진행 중 시도 처리
    if (hold === "held" && !rt.inFlightAttemptId) return waitFor(RUNNER_POLL_INTERVAL_MS); // 활성 연결 0: 신규 호출 보류
    if (hold === "connected") await touchWorldClock(worldId, at); // 월드 시계 확인 (크래시 뒤 정지 구간 제외)
  }

  if (rt.inFlightAttemptId) {
    // lease 만료는 이전 요청이 끝났다는 증거가 아니다. 확실히 끝났을 시간까지 새 호출을 하지 않는다
    const staleAt = (rt.inFlightStartedAt?.getTime() ?? 0) + SCENE_IN_FLIGHT_STALE_MS;
    if (staleAt > at.getTime()) return waitFor(staleAt - at.getTime());
    await finishAttempt(worldId, rt.inFlightAttemptId, { kind: "failed", code: "RESULT_LOST" }, ctx);
    return waitFor(0);
  }
  if (rt.status === "PAUSING") {
    await settlePausing(worldId);
    return EXIT;
  }
  if (!rt.currentRunId) return EXIT;
  const due = rt.nextSceneAt?.getTime() ?? at.getTime();
  if (due > at.getTime()) return waitFor(due - at.getTime());

  await attemptScene(worldId, rt.currentRunId, asAuthenticatedUserId(rt.world.ownerId), ctx);
  return waitFor(0);
}

async function acquireLease(worldId: string, owner: string, now: Date): Promise<boolean> {
  const { count } = await prisma.simulationRuntime.updateMany({
    where: {
      worldId,
      status: { in: ["RUNNING", "PAUSING"] },
      OR: [{ leaseOwner: null }, { leaseOwner: owner }, { leaseExpiresAt: { lt: now } }],
    },
    data: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + RUNNER_LEASE_TTL_MS) },
  });
  return count === 1;
}

async function attemptScene(worldId: string, runId: string, userId: AuthenticatedUserId, ctx: RunnerContext): Promise<void> {
  const { owner, deps } = ctx;
  const now = deps?.now ?? (() => new Date());

  let prepared;
  try {
    prepared = await prepareScene(userId, worldId, deps);
  } catch (error) {
    await finishAttempt(worldId, null, classify(error), ctx, runId);
    return;
  }

  const attemptId = randomUUID();
  const claimed = await claimAttempt(worldId, runId, owner, prepared, attemptId, now(), deps?.random);
  if (!claimed) return; // 그사이 상태가 바뀜 → 다음 단계에서 다시 판단
  notifyWorld(worldId);

  // 호출 중에도 lease를 갱신하고 보류 만료를 확인한다 (만료되면 PAUSING → 이 시도가 끝난 뒤 PAUSED)
  const heartbeat = setInterval(() => {
    void renewLease(worldId, owner, now());
    void touchWorldClock(worldId, now()); // Gemini 호출 중에도 월드 시간은 흐른다
    void reconcileClientHold(worldId, now()).catch((e: unknown) => logServerError("runner.hold", e));
  }, RUNNER_LEASE_RENEW_MS);
  heartbeat.unref?.();
  let outcome: Outcome;
  try {
    const scene = await runSceneAttempt(
      userId,
      worldId,
      prepared,
      {
        attemptId,
        runner: { runId, leaseOwner: owner },
        autoEvent: claimed.autoEvent,
        userEvent: claimed.userEvent,
        beforeRequest: async () => {
          const current = await prisma.simulationRuntime.count({
            where: { worldId, status: "RUNNING", currentRunId: runId, leaseOwner: owner, inFlightAttemptId: attemptId, clientHoldSince: null },
          });
          if (current !== 1) throw new AttemptPreemptedError();
        },
      },
      deps,
    );
    outcome = { kind: "committed", turns: scene.messages.length };
  } catch (error) {
    outcome = classify(error);
  } finally {
    clearInterval(heartbeat);
  }
  await finishAttempt(worldId, attemptId, outcome, ctx, runId);
}

/**
 * 시도 기록 (테스트에서 직접 부른다). 준비 이후 상태·설정이 바뀌었으면 null.
 * 기록에 성공하면 같은 트랜잭션에서 자동 사건 구간을 판정해(구간당 한 번, 영속) 이번 장면의 자동 사건과, 점유한 가장 오래된 대기 사용자 사건을 함께 돌려준다.
 * 호출 전에 시도를 기록한다. 이 조건부 UPDATE가 세계관당 진행 중 생성 1건을 보장한다 (lease와 별개의 2차 방어).
 * 같은 트랜잭션에서 scene.started를 기록하므로 기록에 성공한 Runner만 이벤트를 낸다 (잠금 순서 World → Runtime)
 */
export async function claimAttempt(
  worldId: string,
  runId: string,
  owner: string,
  prepared: Pick<PreparedScene, "characters" | "settingsSeq">,
  attemptId: string,
  startedAt: Date,
  random: () => number = Math.random,
): Promise<{ autoEvent: AutoEventClaim | null; userEvent: UserEventClaim | null } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "World" WHERE "id" = ${worldId} FOR UPDATE`;
    // 준비 이후 설정 수정·불러오기로 settingsSeq가 바뀌었으면 이전 설정으로 호출하지 않고 다음 단계에서 다시 준비한다
    if (!(await settingsUnchanged(tx, worldId, prepared.settingsSeq))) return null;
    const { count } = await tx.simulationRuntime.updateMany({
      where: {
        worldId,
        status: "RUNNING",
        currentRunId: runId,
        leaseOwner: owner,
        inFlightAttemptId: null,
        clientHoldSince: null,
        OR: [{ nextSceneAt: null }, { nextSceneAt: { lte: startedAt } }],
      },
      data: { inFlightAttemptId: attemptId, inFlightStartedAt: startedAt },
    });
    if (count === 0) return null;
    const autoEvent = await claimAutoEvent(tx, worldId, random);
    const userEvent = await claimUserEvent(tx, worldId, attemptId); // 가장 오래된 대기 사용자 사건 (취소 불가가 된다)
    await publishEvents(tx, worldId, [
      {
        type: "scene.started",
        payload: { worldId, attemptId, startedAt: startedAt.toISOString(), participants: prepared.characters.map((c) => c.name) },
      },
    ]);
    return { autoEvent, userEvent };
  });
}

async function renewLease(worldId: string, owner: string, now: Date): Promise<void> {
  try {
    await prisma.simulationRuntime.updateMany({
      where: { worldId, leaseOwner: owner },
      data: { leaseExpiresAt: new Date(now.getTime() + RUNNER_LEASE_TTL_MS) },
    });
  } catch (error) {
    logServerError("runner.lease-renew", error); // lease를 잃어도 커밋 펜싱이 늦은 결과를 막는다
  }
}

function classify(error: unknown): Outcome {
  if (error instanceof UsageLimitError) return { kind: "pause", reason: "USAGE_LIMIT", code: "USAGE_LIMIT" };
  if (error instanceof CircuitOpenError) return { kind: "backoff", until: error.until, code: "BACKOFF" };
  // 연결 미준비·삭제(NotFound: 세계관이 삭제된 경우면 아래 갱신이 0건이라 무해), 키 무효 응답 → 키를 바꿀 때까지 멈춘다
  if (error instanceof ConnectionNotReadyError || error instanceof NotFoundError) return { kind: "pause", reason: "KEY_INVALID", code: "KEY_INVALID" };
  if (error instanceof GeminiRequestError && KEY_FATAL.has(error.kind)) return { kind: "pause", reason: "KEY_INVALID", code: "KEY_INVALID" };
  if (error instanceof AttemptPreemptedError || error instanceof KeyChangedError) return { kind: "skipped", code: "ABORTED" };
  logServerError("runner.scene", error); // 이름·코드만 (키·프롬프트 없음)
  return { kind: "failed", code: failureCode(error) };
}

function failureCode(error: unknown): SceneFailureCode {
  if (error instanceof SceneValidationFailedError) return "VALIDATION_ERROR";
  if (error instanceof GeminiRequestError) return error.kind === "TIMEOUT" || error.kind === "NETWORK_ERROR" ? "NETWORK_ERROR" : "HTTP_ERROR";
  if (error instanceof ConflictError && (error.code === "SCENE_STALE" || error.code === "STALE_REFERENCE")) return "STALE";
  return "INTERNAL_ERROR";
}

/**
 * 진행 중 표시 해제 + 다음 예약 또는 일시정지 + runtime.status를 한 트랜잭션으로. 이어서 PAUSING을 마무리한다.
 * runId를 주면 다음 예약·연속 실패 수는 그 Run이 아직 현재 Run일 때만 반영한다
 * (진행 중 종료 → 바로 시작한 뒤 끝난 이전 Run의 시도가 새 Run의 첫 장면을 미루거나 실패 간격을 늘리지 않게)
 */
async function finishAttempt(worldId: string, attemptId: string | null, outcome: Outcome, ctx: RunnerContext, runId: string | null = null): Promise<void> {
  const now = ctx.deps?.now ?? (() => new Date());
  if (outcome.kind === "committed") ctx.state.failures = 0;
  try {
    const published = await prisma.$transaction(async (tx) => {
      // 잠금 순서 World → Runtime (제어 명령과 같음). outbox INSERT가 World에 FK 잠금을 걸므로 먼저 잡는다
      await tx.$queryRaw`SELECT 1 FROM "World" WHERE "id" = ${worldId} FOR UPDATE`;
      const gs = await tx.gameState.findUnique({ where: { worldId }, select: { intervalPreset: true } });
      if (!gs) return false; // 세계관 삭제
      const at = now();
      if (attemptId) {
        await tx.simulationRuntime.updateMany({ where: { worldId, inFlightAttemptId: attemptId }, data: { inFlightAttemptId: null, inFlightStartedAt: null } });
        await releaseUserEventClaim(tx, worldId, attemptId); // 커밋되지 않은 시도의 사용자 사건 점유를 푼다 (다음 시도가 다시 점유)
        // scene.started를 낸 시도가 커밋되지 않고 끝남을 확정한다 (공개 코드만)
        if (outcome.kind !== "committed") {
          await publishEvents(tx, worldId, [{ type: "scene.failed", payload: { worldId, attemptId, failedAt: at.toISOString(), code: outcome.code } }]);
        }
      }
      if (outcome.kind === "pause") {
        await settleWorldClock(tx, worldId, at, "stop");
        await tx.simulationRuntime.updateMany({
          where: { worldId, status: { in: ["RUNNING", "PAUSING"] } },
          data: { status: "PAUSED", statusReason: outcome.reason, leaseOwner: null, leaseExpiresAt: null, nextSceneAt: null },
        });
      } else if (outcome.kind !== "skipped" && (await currentRun(tx, worldId, runId))) {
        if (outcome.kind === "failed") ctx.state.failures += 1;
        // 속도 설정은 이 시점의 값을 쓴다 (실행 중 변경이 다음 예약부터 반영)
        const next =
          outcome.kind === "committed"
            ? nextSceneAfterCommit(at, gs.intervalPreset, outcome.turns)
            : outcome.kind === "failed"
              ? nextSceneAfterFailure(at, gs.intervalPreset, ctx.state.failures)
              : nextSceneAfterBackoff(at, gs.intervalPreset, outcome.until);
        await tx.simulationRuntime.updateMany({ where: { worldId, status: "RUNNING" }, data: { nextSceneAt: next } });
      }
      await publishRuntimeStatus(tx, worldId);
      return true;
    });
    if (published) notifyWorld(worldId);
  } catch (error) {
    logServerError("runner.finish", error);
  }
  await settlePausing(worldId);
}

/** 이 시도의 Run이 아직 실행 중인 현재 Run인가 (runId가 없으면 현재 Run으로 본다) */
async function currentRun(tx: Prisma.TransactionClient, worldId: string, runId: string | null): Promise<boolean> {
  const rt = await tx.simulationRuntime.findUnique({ where: { worldId }, select: { status: true, currentRunId: true } });
  return rt?.status === "RUNNING" && (runId === null || rt.currentRunId === runId);
}
