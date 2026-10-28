import { CLIENT_HOLD_TIMEOUT_MS, SSE_CONNECTION_ACTIVE_MS } from "../../../../config/limits";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { signalRunner } from "@/server/engine/runner/signal";
import { notifyWorld } from "@/server/events/event-bus";
import { publishRuntimeStatus } from "./control";

// SSE 연결 보류 (architecture.md §7.5 D4, Phase 5-4-3). 런타임 독립. 연결 상태의 기준은 DB(SseConnection)다.
// - 활성 연결 = lastSeenAt이 SSE_CONNECTION_ACTIVE_MS(30초) 이내인 행. 비정상 종료·재시작으로 남은 행은 30초 뒤 비활성이다.
// - RUNNING인데 활성 연결이 0이면 clientHoldSince를 기록한다(보류 시작). 보류 중에는 Runner가 신규 호출을 시작하지 않는다.
// - 활성 연결이 생기면 보류를 해제한다(RUNNING 유지, 새 Run 없음). 60초가 지나도록 연결이 없으면
//   진행 중 시도가 없을 때 PAUSED, 있으면 PAUSING(완료 후 settlePausing이 PAUSED)으로, 사유는 CLIENT_DISCONNECTED.
// - 매번 World 행 잠금 → Runtime 재확인 → 조건부 갱신 → outbox(runtime.status)를 한 트랜잭션에서 한다(잠금 순서 World → Runtime).
//   연결·해제·만료·사용자 명령이 겹쳐도 World 잠금으로 직렬화되고, 상태가 RUNNING이 아니면 아무것도 바꾸지 않는다
//   (사용자 PAUSED·IDLE을 덮어쓰지 않고, PAUSED에서 재접속해도 자동 재개하지 않는다). 상태가 그대로면 이벤트도 없다.

export type ClientHoldResult =
  /** RUNNING이 아님 (보류 정책 대상 아님) */
  | "inactive"
  | "connected"
  | "held"
  /** 유예 만료로 PAUSED 또는 PAUSING이 됨 */
  | "paused";

export const activeConnectionWhere = (worldId: string, now: Date): Prisma.SseConnectionWhereInput => ({
  worldId,
  lastSeenAt: { gte: new Date(now.getTime() - SSE_CONNECTION_ACTIVE_MS) },
});

/**
 * 현재 DB 기준으로 보류를 시작·해제·만료 처리한다. SSE 연결·해제 처리기와 Runner(호출 전·진행 중 heartbeat)가 부른다.
 * 바뀐 경우에만 runtime.status를 기록하고 커밋 후 알린다.
 */
export async function reconcileClientHold(worldId: string, now: Date = new Date()): Promise<ClientHoldResult> {
  const { result, changed } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "World" WHERE "id" = ${worldId} FOR UPDATE`;
    const rt = await tx.simulationRuntime.findUnique({ where: { worldId }, select: { status: true, clientHoldSince: true, inFlightAttemptId: true } });
    if (!rt || rt.status !== "RUNNING") return { result: "inactive" as const, changed: false };

    const active = await tx.sseConnection.count({ where: activeConnectionWhere(worldId, now) });
    if (active > 0) {
      if (rt.clientHoldSince === null) return { result: "connected" as const, changed: false };
      await tx.simulationRuntime.update({ where: { worldId }, data: { clientHoldSince: null } });
      await publishRuntimeStatus(tx, worldId);
      return { result: "connected" as const, changed: true };
    }
    if (rt.clientHoldSince === null) {
      // 재시작 후 보류 기록이 없어도 여기서 지금부터 유예를 시작한다 (즉시 PAUSED로 보내지 않음)
      await tx.simulationRuntime.update({ where: { worldId }, data: { clientHoldSince: now } });
      await publishRuntimeStatus(tx, worldId);
      return { result: "held" as const, changed: true };
    }
    if (now.getTime() - rt.clientHoldSince.getTime() < CLIENT_HOLD_TIMEOUT_MS) return { result: "held" as const, changed: false };

    await tx.simulationRuntime.update({
      where: { worldId },
      data: rt.inFlightAttemptId
        ? { status: "PAUSING", statusReason: "CLIENT_DISCONNECTED", clientHoldSince: null } // 진행 중 장면은 취소하지 않고 마친 뒤 PAUSED
        : { status: "PAUSED", statusReason: "CLIENT_DISCONNECTED", clientHoldSince: null, leaseOwner: null, leaseExpiresAt: null, nextSceneAt: null },
    });
    await publishRuntimeStatus(tx, worldId);
    return { result: "paused" as const, changed: true };
  });
  if (changed) {
    notifyWorld(worldId);
    signalRunner(worldId);
  }
  return result;
}
