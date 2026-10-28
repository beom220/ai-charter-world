import { WORLD_CLOCK_MAX_GAP_MS } from "../../../../config/limits";
import type { Prisma } from "@/generated/prisma/client";
import { realMsForWorldSeconds, worldSecondsForRealMs } from "@/lib/world-clock";
import { prisma } from "@/server/db/client";
import { logServerError } from "@/server/logging/log";

// 월드 시계 (Phase 7-2-2). 런타임 독립. 서버·DB가 권위를 가진다(클라이언트 타이머·로컬 날짜로 판정하지 않는다).
// - 정산된 값: GameState.worldSeconds. 흐르는 중이면 SimulationRuntime.clockAnchorAt(정산 안 된 구간의 시작)이 있다.
// - 흐르는 조건: RUNNING이고 연결 보류가 아님. 시작·재개·보류 해제 때 startWorldClock, 일시정지·종료·보류 시작·자동 일시정지 때
//   settleWorldClock(stop). 장면 커밋은 같은 트랜잭션에서 settleWorldClock(keep)으로 정산해 그 장면의 월드 시각을 정한다.
// - 크래시·긴 정지: Runner가 clockCheckpointAt을 계속 갱신한다(touchWorldClock). 마지막 확인 뒤 30초 넘게 확인이 없었으면
//   그 확인 시각까지만 세고, 다시 흐르게 할 때 기준을 지금으로 옮긴다 → 서버가 꺼져 있던 시간은 소급하지 않는다.
// - 정산은 월드 초 단위로 하고, 정산에 쓰지 못한 실제 ms는 기준 시각에 남겨 다음 정산으로 넘긴다(누락·이중 계산 없음).
// - 호출자는 World 행 잠금을 잡은 트랜잭션에서 부른다(잠금 순서 World → GameState → Runtime).

type Tx = Prisma.TransactionClient;
type ClockRow = { clockAnchorAt: Date | null; clockCheckpointAt: Date | null };

/** 정산 전 구간의 끝: 확인이 끊겼으면 마지막 확인 시각까지만 */
function segmentEnd(rt: ClockRow, now: Date): { end: number; gap: boolean } {
  const checkpoint = rt.clockCheckpointAt?.getTime() ?? rt.clockAnchorAt!.getTime();
  const gap = now.getTime() - checkpoint > WORLD_CLOCK_MAX_GAP_MS;
  return { end: Math.max(rt.clockAnchorAt!.getTime(), gap ? checkpoint : now.getTime()), gap };
}

/** 정산 없이 지금 월드 시간 (상태 표시용) */
export function currentWorldSeconds(settled: number, rt: ClockRow, now: Date): number {
  if (!rt.clockAnchorAt) return settled;
  return settled + worldSecondsForRealMs(segmentEnd(rt, now).end - rt.clockAnchorAt.getTime());
}

/**
 * 흐른 시간을 GameState.worldSeconds에 정산한다. mode "keep"은 흐르던 시계를 계속 흐르게 두고, "stop"은 멈춘다.
 * 정산된 월드 시간을 돌려준다.
 */
export async function settleWorldClock(tx: Tx, worldId: string, now: Date, mode: "keep" | "stop"): Promise<number> {
  const rt = await tx.simulationRuntime.findUnique({ where: { worldId }, select: { clockAnchorAt: true, clockCheckpointAt: true } });
  const gs = await tx.gameState.findUnique({ where: { worldId }, select: { worldSeconds: true } });
  if (!rt || !gs) return gs?.worldSeconds ?? 0;
  if (!rt.clockAnchorAt) return gs.worldSeconds;

  const { end, gap } = segmentEnd(rt, now);
  const add = worldSecondsForRealMs(end - rt.clockAnchorAt.getTime());
  const worldSeconds = gs.worldSeconds + add;
  if (add > 0) await tx.gameState.update({ where: { worldId }, data: { worldSeconds } });
  const anchor = gap ? now : new Date(rt.clockAnchorAt.getTime() + realMsForWorldSeconds(add));
  await tx.simulationRuntime.update({
    where: { worldId },
    data: mode === "keep" ? { clockAnchorAt: anchor, clockCheckpointAt: now } : { clockAnchorAt: null, clockCheckpointAt: null },
  });
  return worldSeconds;
}

/** 시계를 흐르게 한다 (이미 흐르면 그대로) */
export async function startWorldClock(tx: Tx, worldId: string, now: Date): Promise<void> {
  await tx.simulationRuntime.updateMany({ where: { worldId, clockAnchorAt: null }, data: { clockAnchorAt: now, clockCheckpointAt: now } });
}

/**
 * Runner 확인(대기 단계·호출 중 heartbeat). 흐르는 중이면 clockCheckpointAt을 지금으로 갱신한다.
 * 확인이 끊긴 뒤라면(크래시 복구) 끊기기 전까지만 정산하고 기준을 지금으로 옮긴다. 대화 화면이 연결된 RUNNING에서만 부른다.
 */
export async function touchWorldClock(worldId: string, now: Date): Promise<void> {
  try {
    const { count } = await prisma.simulationRuntime.updateMany({
      where: { worldId, clockAnchorAt: { not: null }, clockCheckpointAt: { gte: new Date(now.getTime() - WORLD_CLOCK_MAX_GAP_MS) } },
      data: { clockCheckpointAt: now },
    });
    if (count === 1) return;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "World" WHERE "id" = ${worldId} FOR UPDATE`;
      const rt = await tx.simulationRuntime.findUnique({ where: { worldId }, select: { clockAnchorAt: true, status: true, clientHoldSince: true } });
      if (rt?.clockAnchorAt) await settleWorldClock(tx, worldId, now, "keep");
      // 시계 도입 전부터 RUNNING이던 세계관(또는 기준이 지워진 경우): 지금부터 흐르게 한다
      else if (rt?.status === "RUNNING" && rt.clientHoldSince === null) await startWorldClock(tx, worldId, now);
    });
  } catch (error) {
    logServerError("world-clock.touch", error); // 확인이 늦어도 정산은 마지막 확인 시각까지만이라 안전하다
  }
}
