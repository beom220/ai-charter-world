import { SCENE_IN_FLIGHT_STALE_MS, USER_EVENT_MIN_INTERVAL_MS, USER_EVENT_PENDING_MAX, USER_EVENTS_PER_DAY } from "../../../../config/limits";
import type { Prisma } from "@/generated/prisma/client";
import type { UserEventInput } from "@/lib/schemas/world-event";
import { prisma } from "@/server/db/client";
import { ConflictError, NotFoundError, TooManyRequestsError } from "@/server/domain/errors";
import type { AuthenticatedUserId } from "@/server/domain/identity";
import { notifyWorld, publishEvents } from "@/server/events/event-bus";
import { nextKstMidnight } from "@/server/engine/usage/kst";

// 사용자 지정 사건 (Phase 7-2-3, architecture.md §13.3). 런타임 독립.
// - 등록: World 행 잠금(소유자 조건) 아래에서 멱등 키 → 대기 3건 → 제출 간격 30초 → KST 하루 30건 순으로 검사하고 PENDING으로 만든다.
//   같은 세계관의 등록·취소·시도 점유가 World 잠금으로 직렬화되므로 동시 제출로 한도를 넘지 않는다. 대기 사건은 30초 간격이라 등록 순서가 createdAt 순이다.
//   사건 등록은 설정 변경이 아니다: 첫 장면 이후에도 허용하고 settingsSeq를 올리지 않는다(changeSeq만 — 대기 사건도 세이브에 들어간다).
// - 점유: 장면 시도를 기록하는 트랜잭션(World 잠금 → Runtime, 펜싱 안)에서 가장 오래된 PENDING 1건에 claimedAttemptId를 단다.
//   세계관당 진행 중 시도는 1건뿐이므로, 다른 시도 ID로 남은 점유(크래시 등)는 이때 함께 푼다. 시도가 끝나면(성공은 커밋에서 ACTIVE로,
//   실패·펜싱 거부는 releaseUserEventClaim으로) 점유가 풀린다.
// - 취소: World 잠금 아래에서 PENDING이고 진행 중 시도에 점유되지 않은 사건만. 점유한 시도가 오래되어(SCENE_IN_FLIGHT_STALE_MS) 끝난 것으로
//   보이면 취소를 허용하고 점유를 지운다 → 그 시도가 뒤늦게 커밋하려 해도 커밋 트랜잭션의 점유 확인에서 거부되어 취소된 사건이 대사에 남지 않는다.

type Tx = Prisma.TransactionClient;

const TITLE_MAX = 40;
const titleOf = (text: string) => {
  const cps = [...text];
  return cps.length > TITLE_MAX ? `${cps.slice(0, TITLE_MAX).join("")}…` : text;
};

export type PendingUserEventView = { id: string; text: string; createdAt: Date; claimed: boolean };

async function lockOwnedWorld(tx: Tx, userId: AuthenticatedUserId, worldId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "World" WHERE "id" = ${worldId} AND "ownerId" = ${userId} FOR UPDATE`;
  if (!rows.length) throw new NotFoundError();
}

/** 진행 중 시도가 지금 점유하고 있는가 (오래된 시도는 끝난 것으로 본다) */
async function occupiedBy(db: Tx | typeof prisma, worldId: string, now: Date): Promise<string | null> {
  const rt = await db.simulationRuntime.findUnique({ where: { worldId }, select: { inFlightAttemptId: true, inFlightStartedAt: true } });
  if (!rt?.inFlightAttemptId || !rt.inFlightStartedAt) return null;
  return rt.inFlightStartedAt.getTime() + SCENE_IN_FLIGHT_STALE_MS > now.getTime() ? rt.inFlightAttemptId : null;
}

const toPending = (e: { id: string; description: string; createdAt: Date; claimedAttemptId: string | null }, inFlight: string | null): PendingUserEventView => ({
  id: e.id,
  text: e.description,
  createdAt: e.createdAt,
  claimed: e.claimedAttemptId !== null && e.claimedAttemptId === inFlight,
});

const pendingSelect = { id: true, description: true, createdAt: true, claimedAttemptId: true } as const;

/** 사건 등록. 같은 requestId 재전송이면 기존 사건을 그대로 돌려준다(created: false) */
export async function submitUserEvent(
  userId: AuthenticatedUserId,
  worldId: string,
  input: UserEventInput,
  now: Date = new Date(),
): Promise<{ event: PendingUserEventView; created: boolean }> {
  const result = await prisma.$transaction(async (tx) => {
    await lockOwnedWorld(tx, userId, worldId);
    const inFlight = await occupiedBy(tx, worldId, now);
    const existing = await tx.worldEvent.findUnique({ where: { worldId_requestId: { worldId, requestId: input.requestId } }, select: { ...pendingSelect, kind: true } });
    if (existing) {
      if (existing.kind !== "USER_INTERVENTION" || existing.description !== input.text) {
        throw new ConflictError("USER_EVENT_REQUEST_REUSED", "이미 다른 내용으로 처리된 요청입니다. 새로 입력해 주세요.");
      }
      return { event: toPending(existing, inFlight), created: false };
    }
    const pending = await tx.worldEvent.count({ where: { worldId, kind: "USER_INTERVENTION", status: "PENDING" } });
    if (pending >= USER_EVENT_PENDING_MAX) {
      throw new ConflictError("USER_EVENT_PENDING_LIMIT", `대기 중인 사건은 최대 ${USER_EVENT_PENDING_MAX}개입니다. 사건이 발생하거나 취소한 뒤 다시 등록하세요.`);
    }
    const last = await tx.worldEvent.findFirst({ where: { worldId, kind: "USER_INTERVENTION" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const waitMs = last ? last.createdAt.getTime() + USER_EVENT_MIN_INTERVAL_MS - now.getTime() : 0;
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);
      throw new TooManyRequestsError("USER_EVENT_TOO_SOON", `사건은 ${USER_EVENT_MIN_INTERVAL_MS / 1000}초에 한 번 등록할 수 있습니다. ${seconds}초 뒤에 다시 시도하세요.`, seconds);
    }
    const dayStart = new Date(nextKstMidnight(now).getTime() - 24 * 60 * 60 * 1000);
    const today = await tx.worldEvent.count({ where: { worldId, kind: "USER_INTERVENTION", createdAt: { gte: dayStart } } });
    if (today >= USER_EVENTS_PER_DAY) {
      const seconds = Math.ceil((nextKstMidnight(now).getTime() - now.getTime()) / 1000);
      throw new TooManyRequestsError("USER_EVENT_DAILY_LIMIT", `사건은 하루(한국 시간 기준) ${USER_EVENTS_PER_DAY}개까지 등록할 수 있습니다.`, seconds);
    }
    const event = await tx.worldEvent.create({
      data: {
        worldId,
        kind: "USER_INTERVENTION",
        status: "PENDING",
        intensity: "MEDIUM", // 기본 중강도. 고강도 악화는 장면 결과가 실제 위험을 보고한 경우에만 (event-rules)
        title: titleOf(input.text),
        description: input.text,
        requestId: input.requestId,
        createdAt: now,
      },
      select: pendingSelect,
    });
    await tx.gameState.update({ where: { worldId }, data: { changeSeq: { increment: 1 } } });
    await publishEvents(tx, worldId, [{ type: "world_event.updated", payload: { worldId, reason: "submitted", eventId: event.id } }]);
    return { event: toPending(event, inFlight), created: true };
  });
  if (result.created) notifyWorld(worldId);
  return result;
}

/** 대기 사건 취소. 이미 발생·취소됐거나 진행 중 시도에 포함된 사건은 409 */
export async function cancelUserEvent(userId: AuthenticatedUserId, worldId: string, eventId: string, now: Date = new Date()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockOwnedWorld(tx, userId, worldId);
    const event = await tx.worldEvent.findFirst({ where: { id: eventId, worldId, kind: "USER_INTERVENTION" }, select: { status: true, claimedAttemptId: true } });
    if (!event) throw new NotFoundError();
    if (event.status !== "PENDING") throw new ConflictError("USER_EVENT_NOT_CANCELLABLE", "이미 발생했거나 취소된 사건은 취소할 수 없습니다.");
    if (event.claimedAttemptId !== null && event.claimedAttemptId === (await occupiedBy(tx, worldId, now))) {
      throw new ConflictError("USER_EVENT_IN_PROGRESS", "지금 만들고 있는 장면에 포함된 사건이라 취소할 수 없습니다.");
    }
    await tx.worldEvent.update({ where: { id: eventId }, data: { status: "CANCELLED", cancelledAt: now, claimedAttemptId: null } });
    await tx.gameState.update({ where: { worldId }, data: { changeSeq: { increment: 1 } } });
    await publishEvents(tx, worldId, [{ type: "world_event.updated", payload: { worldId, reason: "cancelled", eventId } }]);
  });
  notifyWorld(worldId);
}

/** 대기 사건 (등록 순) */
export async function listPendingUserEvents(worldId: string, now: Date = new Date()): Promise<PendingUserEventView[]> {
  const [rows, inFlight] = await Promise.all([
    prisma.worldEvent.findMany({ where: { worldId, kind: "USER_INTERVENTION", status: "PENDING" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: pendingSelect }),
    occupiedBy(prisma, worldId, now),
  ]);
  return rows.map((e) => toPending(e, inFlight));
}

export type UserEventClaim = { eventId: string; attemptId: string };

/**
 * 시도 기록 트랜잭션(World 잠금, 진행 중 시도로 attemptId를 막 기록한 뒤)에서 부른다. 다른 시도의 남은 점유를 풀고
 * 가장 오래된 대기 사용자 사건 1건을 이 시도에 점유시킨다.
 */
export async function claimUserEvent(tx: Tx, worldId: string, attemptId: string): Promise<UserEventClaim | null> {
  await tx.worldEvent.updateMany({ where: { worldId, status: "PENDING", claimedAttemptId: { not: attemptId } }, data: { claimedAttemptId: null } });
  const next = await tx.worldEvent.findFirst({
    where: { worldId, kind: "USER_INTERVENTION", status: "PENDING" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!next) return null;
  await tx.worldEvent.update({ where: { id: next.id }, data: { claimedAttemptId: attemptId } });
  return { eventId: next.id, attemptId };
}

/** 시도 종료(실패·펜싱 거부·건너뜀): 커밋되지 않은 점유를 푼다. 커밋된 사건은 이미 ACTIVE라 해당 없음 */
export async function releaseUserEventClaim(db: Tx | typeof prisma, worldId: string, attemptId: string): Promise<void> {
  await db.worldEvent.updateMany({ where: { worldId, status: "PENDING", claimedAttemptId: attemptId }, data: { claimedAttemptId: null } });
}
