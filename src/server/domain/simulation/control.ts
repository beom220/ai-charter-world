import { AUTO_SAVE_INTERVAL_MS, CLIENT_HOLD_TIMEOUT_MS, SCENE_PARTICIPANTS_MIN } from "../../../../config/limits";
import type { IntervalPreset, Prisma } from "@/generated/prisma/client";
import type { SimulationStateView } from "@/lib/simulation-view";
import { prisma } from "@/server/db/client";
import { requireOwnedWorld } from "@/server/db/scope";
import { ConflictError } from "@/server/domain/errors";
import type { AuthenticatedUserId } from "@/server/domain/identity";
import { requireUsableGeminiConnection } from "@/server/domain/providers/gemini-verification";
import { lockOwnedWorld } from "@/server/domain/worlds";
import { signalRunner } from "@/server/engine/runner/signal";
import { decideTransition, type SimulationCommand } from "@/server/engine/runner/transitions";
import { assertDailyUsageAvailable } from "@/server/engine/usage/usage-guard";
import { notifyWorld, publishEvents } from "@/server/events/event-bus";
import { logServerError } from "@/server/logging/log";
import { currentWorldSeconds, settleWorldClock, startWorldClock } from "./world-clock";

// 시뮬레이션 실행 제어 (architecture.md §7.1·§7.2, Phase 5-4-1). 런타임 독립.
// - 상태의 기준은 SimulationRuntime 행이다. 명령은 상태만 바꾸고 RunnerHost에 신호(signalRunner)만 보낸다.
//   RUNNING은 "실행해도 된다"는 허가 상태이고, 실제 장면 생성은 Runner(engine/runner, Phase 5-4-2)가 한다.
// - 명령마다 한 트랜잭션: World 행 잠금(같은 세계관 명령 직렬화) → [stop: GameState 잠금] → 상태 전이 → outbox(runtime.status).
//   커밋 후 SSE 구독자에게 알린다. 같은 명령의 반복·동시 요청은 noop으로 200과 현재 상태를 돌려준다.
// - lease(leaseOwner·leaseExpiresAt)는 Runner 소유다. 여기서는 PAUSED·IDLE이 될 때만 해제한다(§7.4 "해제").
// - 사전 조건(start·resume): 연결 ACTIVE + 모델, 대화 가능한(생존) 캐릭터 2명 이상, 오늘 일일 한도 미도달.
// - 월드 시계(Phase 7-2-2, world-clock.ts): 시작·재개 때 흐르게 하고, 일시정지·종료 때 같은 트랜잭션에서 정산해 멈춘다.

// 상태 API·runtime.status payload. 화면(lib/simulation-view.ts)과 같은 정의를 쓴다
export type { SimulationStateView };

type Tx = Prisma.TransactionClient;

const STATUS_MESSAGE: Record<SimulationCommand, string> = {
  start: "이미 시작된 시뮬레이션입니다. 일시정지 상태라면 재개를 누르세요.",
  pause: "실행 중이 아니어서 일시정지할 수 없습니다.",
  resume: "일시정지 상태에서만 재개할 수 있습니다.",
  stop: "",
};

async function readState(db: Tx | typeof prisma, worldId: string, now: Date = new Date()): Promise<SimulationStateView> {
  const [runtime, gameState] = await Promise.all([
    db.simulationRuntime.findUniqueOrThrow({ where: { worldId } }),
    db.gameState.findUniqueOrThrow({ where: { worldId }, select: { intervalPreset: true, worldSeconds: true } }),
  ]);
  return {
    status: runtime.status,
    statusReason: runtime.statusReason,
    runId: runtime.currentRunId,
    intervalPreset: gameState.intervalPreset,
    nextSceneAt: runtime.nextSceneAt?.toISOString() ?? null,
    inFlight: runtime.inFlightAttemptId !== null,
    held: runtime.status === "RUNNING" && runtime.clientHoldSince !== null,
    holdDeadline:
      runtime.status === "RUNNING" && runtime.clientHoldSince ? new Date(runtime.clientHoldSince.getTime() + CLIENT_HOLD_TIMEOUT_MS).toISOString() : null,
    worldClock: { seconds: currentWorldSeconds(gameState.worldSeconds, runtime, now), running: runtime.clockAnchorAt !== null, asOf: now.toISOString() },
  };
}

/** 현재 상태를 outbox(runtime.status)에 기록한다 (트랜잭션 안). Runner도 쓴다 */
export async function publishRuntimeStatus(tx: Tx, worldId: string, now: Date = new Date()): Promise<SimulationStateView> {
  const state = await readState(tx, worldId, now);
  await publishEvents(tx, worldId, [{ type: "runtime.status", payload: state }]);
  return state;
}

export async function getSimulationState(userId: AuthenticatedUserId, worldId: string): Promise<SimulationStateView> {
  await requireOwnedWorld(userId, worldId);
  return readState(prisma, worldId);
}

async function assertCanRun(userId: AuthenticatedUserId, worldId: string, tx: Tx): Promise<void> {
  const { connectionId } = await requireUsableGeminiConnection(userId);
  // 사망자는 슬롯을 차지하지만 대화할 수 없다 (신체 상태 행이 없으면 생존으로 본다)
  const alive = await tx.character.count({ where: { worldId, deletedAt: null, OR: [{ condition: null }, { condition: { vital: "ALIVE" } }] } });
  if (alive < SCENE_PARTICIPANTS_MIN) {
    throw new ConflictError("NOT_ENOUGH_CHARACTERS", `시뮬레이션을 시작하려면 대화할 수 있는 생존 캐릭터가 ${SCENE_PARTICIPANTS_MIN}명 이상 필요합니다.`);
  }
  await assertDailyUsageAvailable(connectionId);
}

export async function runSimulationCommand(
  userId: AuthenticatedUserId,
  worldId: string,
  command: SimulationCommand,
  now: () => Date = () => new Date(),
): Promise<{ state: SimulationStateView; changed: boolean }> {
  const result = await prisma.$transaction(async (tx) => {
    await lockOwnedWorld(tx, userId, worldId);
    const runtime = await tx.simulationRuntime.findUniqueOrThrow({ where: { worldId } });
    const decision = decideTransition(command, runtime.status, runtime.inFlightAttemptId !== null);
    if (decision.kind === "reject") throw new ConflictError("INVALID_TRANSITION", STATUS_MESSAGE[command]);
    if (decision.kind === "noop") return { state: await readState(tx, worldId), changed: false };

    const at = now();
    const released = { leaseOwner: null, leaseExpiresAt: null, nextSceneAt: null };
    if (command === "start") {
      await assertCanRun(userId, worldId, tx);
      const run = await tx.simulationRun.create({ data: { worldId, startedAt: at }, select: { id: true } });
      await tx.simulationRuntime.update({
        where: { worldId },
        data: {
          status: "RUNNING",
          statusReason: "USER",
          currentRunId: run.id,
          nextSceneAt: at,
          clientHoldSince: null,
          nextAutoSaveAt: nextAutoSaveOnRun(runtime.nextAutoSaveAt, at),
        },
      });
      await startWorldClock(tx, worldId, at);
    } else if (command === "resume") {
      await assertCanRun(userId, worldId, tx);
      await tx.simulationRuntime.update({
        where: { worldId },
        data: { status: "RUNNING", statusReason: "USER", nextSceneAt: at, clientHoldSince: null, nextAutoSaveAt: nextAutoSaveOnRun(runtime.nextAutoSaveAt, at) },
      });
      await startWorldClock(tx, worldId, at);
    } else if (command === "pause") {
      await settleWorldClock(tx, worldId, at, "stop"); // 진행 중 장면을 마치는 PAUSING 동안에도 월드 시간은 멈춘다
      await tx.simulationRuntime.update({
        where: { worldId },
        // PAUSING은 진행 중 장면을 마칠 때까지 lease를 유지한다
        data: decision.next === "PAUSED" ? { status: "PAUSED", statusReason: "USER", ...released } : { status: "PAUSING", statusReason: "USER" },
      });
    } else {
      // stop: 펜싱 토큰을 올려 그 전에 시작된 시도의 커밋을 막는다 (잠금 순서 World → GameState → Runtime)
      await settleWorldClock(tx, worldId, at, "stop");
      await tx.$executeRaw`UPDATE "GameState" SET "stateVersion" = "stateVersion" + 1, "updatedAt" = now() WHERE "worldId" = ${worldId}`;
      if (runtime.currentRunId) {
        await tx.simulationRun.updateMany({ where: { id: runtime.currentRunId, worldId, endedAt: null }, data: { endedAt: at, endReason: "USER" } });
      }
      await tx.simulationRuntime.update({
        where: { worldId },
        data: { status: "IDLE", statusReason: "USER", currentRunId: null, clientHoldSince: null, ...released },
      });
    }
    return { state: await publishRuntimeStatus(tx, worldId, at), changed: true };
  });
  if (result.changed) {
    notifyWorld(worldId);
    signalRunner(worldId); // 루프를 직접 조작하지 않고 RunnerHost에 알리기만 한다 (§7.2)
  }
  return result;
}

/**
 * 시작·재개 때 다음 자동 저장 시각 (Phase 6). 아직 남은 예정이 있으면 유지하고(마지막 성공 + 1시간),
 * 없거나 이미 지났으면 지금부터 1시간 뒤로 둔다. 시작·재개만으로 바로 저장하지 않는다.
 */
export function nextAutoSaveOnRun(current: Date | null, now: Date): Date {
  return current && current > now ? current : new Date(now.getTime() + AUTO_SAVE_INTERVAL_MS);
}

/** 실행 속도(장면 간격 SLOW 15s / NORMAL 5s / FAST 1s) 저장. 실행 중에도 허용, 바뀐 경우에만 changeSeq += 1 (스냅샷 runSettings) */
export async function updateSimulationSettings(
  userId: AuthenticatedUserId,
  worldId: string,
  intervalPreset: IntervalPreset,
): Promise<{ state: SimulationStateView; changed: boolean }> {
  const result = await prisma.$transaction(async (tx) => {
    await lockOwnedWorld(tx, userId, worldId);
    const updated = await tx.gameState.updateMany({
      where: { worldId, intervalPreset: { not: intervalPreset } },
      data: { intervalPreset, changeSeq: { increment: 1 } },
    });
    if (updated.count === 0) return { state: await readState(tx, worldId), changed: false };
    return { state: await publishRuntimeStatus(tx, worldId), changed: true };
  });
  if (result.changed) notifyWorld(worldId);
  return result;
}

/**
 * 진행 중 장면이 끝난 뒤(커밋·실패 모두) 호출한다. PAUSING이면 PAUSED로 마무리하고 lease를 해제한다.
 * 이 시도의 inFlight 표시가 이미 지워진 뒤에 부른다. 실패해도 호출자 결과를 가리지 않는다.
 */
export async function settlePausing(worldId: string): Promise<void> {
  try {
    const done = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "World" WHERE "id" = ${worldId} FOR UPDATE`; // 잠금 순서 World → Runtime (제어 명령과 같음)
      const moved = await tx.simulationRuntime.updateMany({
        where: { worldId, status: "PAUSING", inFlightAttemptId: null },
        data: { status: "PAUSED", leaseOwner: null, leaseExpiresAt: null, nextSceneAt: null },
      });
      if (moved.count === 0) return false;
      await publishRuntimeStatus(tx, worldId);
      return true;
    });
    if (done) notifyWorld(worldId);
  } catch (error) {
    logServerError("simulation.settle-pausing", error);
  }
}
