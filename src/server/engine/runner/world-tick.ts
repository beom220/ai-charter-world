import { randomUUID } from "node:crypto";
import { RUNNER_LEASE_RENEW_MS, RUNNER_LEASE_TTL_MS, RUNNER_POLL_INTERVAL_MS, SCENE_IN_FLIGHT_STALE_MS } from "../../../../config/limits";
import type { StatusReason } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId, type AuthenticatedUserId } from "@/server/domain/identity";
import { ConnectionNotReadyError, GeminiRequestError } from "@/server/domain/providers/gemini-verification";
import { prepareScene, runSceneAttempt, type SceneDeps } from "@/server/domain/scenes/generate-scene";
import { publishRuntimeStatus, settlePausing } from "@/server/domain/simulation/control";
import { CircuitOpenError, KeyChangedError, UsageLimitError } from "@/server/engine/usage/errors";
import { notifyWorld } from "@/server/events/event-bus";
import { logServerError } from "@/server/logging/log";
import { nextSceneAfterBackoff, nextSceneAfterCommit, nextSceneAfterFailure } from "./schedule";

// 세계관 1개의 Runner 한 단계 (architecture.md §6.3·§7.4, Phase 5-4-2). 런타임 독립. 상태의 기준은 DB다.
//   1) lease 획득·갱신 (조건부 UPDATE 1건: RUNNING·PAUSING이고 비었거나 내 것이거나 만료) — 실패하면 종료
//   2) 남아 있는 진행 중 시도(다른 프로세스가 남김)는 결과가 불확실하므로 재시도하지 않는다.
//      요청 타임아웃(60초)보다 긴 SCENE_IN_FLIGHT_STALE_MS가 지날 때까지 새 호출을 하지 않고, 지나면 버린다
//   3) PAUSING이면 PAUSED로 마무리하고 종료. RUNNING이면 nextSceneAt까지 대기
//   4) 참가자·연결·키 준비 → 시도 기록(조건부 UPDATE: RUNNING + 같은 Run + lease 소유 + 진행 중 없음 + 예정 시각 도달)
//      → 요청 직전 재검증 → UsageGuard 예약 → Gemini 1회 → 검증 → 펜싱 커밋(stateVersion·Run·lease·attemptId) + outbox
//   5) 진행 중 표시 해제 + 다음 예약(nextSceneAt) 또는 PAUSED(USAGE_LIMIT·KEY_INVALID) + runtime.status, 한 트랜잭션
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

type Outcome =
  | { kind: "committed"; turns: number }
  | { kind: "failed" }
  | { kind: "backoff"; until: Date }
  | { kind: "pause"; reason: StatusReason }
  /** 외부 요청 전에 멈춤(상태 변경·키 교체). 실패로 세지 않고 예약도 바꾸지 않는다 */
  | { kind: "skipped" };

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

  if (rt.inFlightAttemptId) {
    // lease 만료는 이전 요청이 끝났다는 증거가 아니다. 확실히 끝났을 시간까지 새 호출을 하지 않는다
    const staleAt = (rt.inFlightStartedAt?.getTime() ?? 0) + SCENE_IN_FLIGHT_STALE_MS;
    if (staleAt > at.getTime()) return waitFor(staleAt - at.getTime());
    await finishAttempt(worldId, rt.inFlightAttemptId, { kind: "failed" }, ctx);
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
    await finishAttempt(worldId, null, classify(error), ctx);
    return;
  }

  // 호출 전에 시도를 기록한다. 이 조건부 UPDATE가 세계관당 진행 중 생성 1건을 보장한다 (lease와 별개의 2차 방어)
  const attemptId = randomUUID();
  const startedAt = now();
  const claimed = await prisma.simulationRuntime.updateMany({
    where: {
      worldId,
      status: "RUNNING",
      currentRunId: runId,
      leaseOwner: owner,
      inFlightAttemptId: null,
      OR: [{ nextSceneAt: null }, { nextSceneAt: { lte: startedAt } }],
    },
    data: { inFlightAttemptId: attemptId, inFlightStartedAt: startedAt },
  });
  if (claimed.count === 0) return; // 그사이 상태가 바뀜 → 다음 단계에서 다시 판단

  const heartbeat = setInterval(() => void renewLease(worldId, owner, now()), RUNNER_LEASE_RENEW_MS);
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
        beforeRequest: async () => {
          const current = await prisma.simulationRuntime.count({
            where: { worldId, status: "RUNNING", currentRunId: runId, leaseOwner: owner, inFlightAttemptId: attemptId },
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
  await finishAttempt(worldId, attemptId, outcome, ctx);
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
  if (error instanceof UsageLimitError) return { kind: "pause", reason: "USAGE_LIMIT" };
  if (error instanceof CircuitOpenError) return { kind: "backoff", until: error.until };
  // 연결 미준비·삭제(NotFound: 세계관이 삭제된 경우면 아래 갱신이 0건이라 무해), 키 무효 응답 → 키를 바꿀 때까지 멈춘다
  if (error instanceof ConnectionNotReadyError || error instanceof NotFoundError) return { kind: "pause", reason: "KEY_INVALID" };
  if (error instanceof GeminiRequestError && KEY_FATAL.has(error.kind)) return { kind: "pause", reason: "KEY_INVALID" };
  if (error instanceof AttemptPreemptedError || error instanceof KeyChangedError) return { kind: "skipped" };
  logServerError("runner.scene", error); // 이름·코드만 (키·프롬프트 없음)
  return { kind: "failed" };
}

/** 진행 중 표시 해제 + 다음 예약 또는 일시정지 + runtime.status를 한 트랜잭션으로. 이어서 PAUSING을 마무리한다 */
async function finishAttempt(worldId: string, attemptId: string | null, outcome: Outcome, ctx: RunnerContext): Promise<void> {
  const now = ctx.deps?.now ?? (() => new Date());
  if (outcome.kind === "committed") ctx.state.failures = 0;
  if (outcome.kind === "failed") ctx.state.failures += 1;
  try {
    const published = await prisma.$transaction(async (tx) => {
      // 잠금 순서 World → Runtime (제어 명령과 같음). outbox INSERT가 World에 FK 잠금을 걸므로 먼저 잡는다
      await tx.$queryRaw`SELECT 1 FROM "World" WHERE "id" = ${worldId} FOR UPDATE`;
      const gs = await tx.gameState.findUnique({ where: { worldId }, select: { intervalPreset: true } });
      if (!gs) return false; // 세계관 삭제
      const at = now();
      if (attemptId) {
        await tx.simulationRuntime.updateMany({ where: { worldId, inFlightAttemptId: attemptId }, data: { inFlightAttemptId: null, inFlightStartedAt: null } });
      }
      if (outcome.kind === "pause") {
        await tx.simulationRuntime.updateMany({
          where: { worldId, status: { in: ["RUNNING", "PAUSING"] } },
          data: { status: "PAUSED", statusReason: outcome.reason, leaseOwner: null, leaseExpiresAt: null, nextSceneAt: null },
        });
      } else if (outcome.kind !== "skipped") {
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
