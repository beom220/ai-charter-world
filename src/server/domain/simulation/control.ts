import { SCENE_PARTICIPANTS_MIN } from "../../../../config/limits";
import type { IntervalPreset, Prisma, StatusReason } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { requireOwnedWorld } from "@/server/db/scope";
import { ConflictError } from "@/server/domain/errors";
import type { AuthenticatedUserId } from "@/server/domain/identity";
import { requireUsableGeminiConnection } from "@/server/domain/providers/gemini-verification";
import { lockOwnedWorld } from "@/server/domain/worlds";
import { decideTransition, type SimulationCommand } from "@/server/engine/runner/transitions";
import { assertDailyUsageAvailable } from "@/server/engine/usage/usage-guard";
import { notifyWorld, publishEvents } from "@/server/events/event-bus";
import { logServerError } from "@/server/logging/log";

// 시뮬레이션 실행 제어 (architecture.md §7.1·§7.2, Phase 5-4-1). 런타임 독립.
// - 상태의 기준은 SimulationRuntime 행이다. 이 단계는 상태만 바꾸며 Runner·Gemini 호출을 시작하지 않는다.
//   RUNNING은 "실행해도 된다"는 허가 상태이고, 실제 루프는 Phase 5-4-2에서 붙는다.
// - 명령마다 한 트랜잭션: World 행 잠금(같은 세계관 명령 직렬화) → [stop: GameState 잠금] → 상태 전이 → outbox(runtime.status).
//   커밋 후 SSE 구독자에게 알린다. 같은 명령의 반복·동시 요청은 noop으로 200과 현재 상태를 돌려준다.
// - lease(leaseOwner·leaseExpiresAt)는 Runner 소유다. 여기서는 PAUSED·IDLE이 될 때만 해제한다(§7.4 "해제").
// - 사전 조건(start·resume): 연결 ACTIVE + 모델, 활성 캐릭터 2명 이상, 오늘 일일 한도 미도달.

export type SimulationStateView = {
  status: "IDLE" | "RUNNING" | "PAUSING" | "PAUSED";
  statusReason: StatusReason | null;
  runId: string | null;
  intervalPreset: IntervalPreset;
  nextSceneAt: string | null;
  inFlight: boolean;
  /** SSE 연결 보류 (Phase 5-4-3에서 채운다) */
  held: boolean;
};

type Tx = Prisma.TransactionClient;

const STATUS_MESSAGE: Record<SimulationCommand, string> = {
  start: "이미 시작된 시뮬레이션입니다. 일시정지 상태라면 재개를 누르세요.",
  pause: "실행 중이 아니어서 일시정지할 수 없습니다.",
  resume: "일시정지 상태에서만 재개할 수 있습니다.",
  stop: "",
};

async function readState(db: Tx | typeof prisma, worldId: string): Promise<SimulationStateView> {
  const [runtime, gameState] = await Promise.all([
    db.simulationRuntime.findUniqueOrThrow({ where: { worldId } }),
    db.gameState.findUniqueOrThrow({ where: { worldId }, select: { intervalPreset: true } }),
  ]);
  return {
    status: runtime.status,
    statusReason: runtime.statusReason,
    runId: runtime.currentRunId,
    intervalPreset: gameState.intervalPreset,
    nextSceneAt: runtime.nextSceneAt?.toISOString() ?? null,
    inFlight: runtime.inFlightAttemptId !== null,
    held: runtime.clientHoldSince !== null,
  };
}

/** 현재 상태를 outbox에 기록한다 (트랜잭션 안) */
async function publishState(tx: Tx, worldId: string): Promise<SimulationStateView> {
  const state = await readState(tx, worldId);
  await publishEvents(tx, worldId, [{ type: "runtime.status", payload: state }]);
  return state;
}

export async function getSimulationState(userId: AuthenticatedUserId, worldId: string): Promise<SimulationStateView> {
  await requireOwnedWorld(userId, worldId);
  return readState(prisma, worldId);
}

async function assertCanRun(userId: AuthenticatedUserId, worldId: string, tx: Tx): Promise<void> {
  const { connectionId } = await requireUsableGeminiConnection(userId);
  const active = await tx.character.count({ where: { worldId, deletedAt: null } });
  if (active < SCENE_PARTICIPANTS_MIN) {
    throw new ConflictError("NOT_ENOUGH_CHARACTERS", `시뮬레이션을 시작하려면 활성 캐릭터가 ${SCENE_PARTICIPANTS_MIN}명 이상 필요합니다.`);
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
        data: { status: "RUNNING", statusReason: "USER", currentRunId: run.id, nextSceneAt: at, clientHoldSince: null },
      });
    } else if (command === "resume") {
      await assertCanRun(userId, worldId, tx);
      await tx.simulationRuntime.update({ where: { worldId }, data: { status: "RUNNING", statusReason: "USER", nextSceneAt: at } });
    } else if (command === "pause") {
      await tx.simulationRuntime.update({
        where: { worldId },
        // PAUSING은 진행 중 장면을 마칠 때까지 lease를 유지한다
        data: decision.next === "PAUSED" ? { status: "PAUSED", statusReason: "USER", ...released } : { status: "PAUSING", statusReason: "USER" },
      });
    } else {
      // stop: 펜싱 토큰을 올려 그 전에 시작된 시도의 커밋을 막는다 (잠금 순서 World → GameState → Runtime)
      await tx.$executeRaw`UPDATE "GameState" SET "stateVersion" = "stateVersion" + 1, "updatedAt" = now() WHERE "worldId" = ${worldId}`;
      if (runtime.currentRunId) {
        await tx.simulationRun.updateMany({ where: { id: runtime.currentRunId, worldId, endedAt: null }, data: { endedAt: at, endReason: "USER" } });
      }
      await tx.simulationRuntime.update({
        where: { worldId },
        data: { status: "IDLE", statusReason: "USER", currentRunId: null, clientHoldSince: null, ...released },
      });
    }
    return { state: await publishState(tx, worldId), changed: true };
  });
  if (result.changed) notifyWorld(worldId);
  return result;
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
    return { state: await publishState(tx, worldId), changed: true };
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
      const moved = await tx.simulationRuntime.updateMany({
        where: { worldId, status: "PAUSING", inFlightAttemptId: null },
        data: { status: "PAUSED", leaseOwner: null, leaseExpiresAt: null, nextSceneAt: null },
      });
      if (moved.count === 0) return false;
      await publishState(tx, worldId);
      return true;
    });
    if (done) notifyWorld(worldId);
  } catch (error) {
    logServerError("simulation.settle-pausing", error);
  }
}
