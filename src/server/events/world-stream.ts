import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { SSE_HEARTBEAT_INTERVAL_MS, SSE_PING_INTERVAL_MS, SSE_REPLAY_MAX_EVENTS } from "../../../config/limits";
import { prisma } from "@/server/db/client";
import { requireOwnedWorld } from "@/server/db/scope";
import { reconcileClientHold } from "@/server/domain/simulation/client-hold";
import type { AuthenticatedUserId } from "@/server/domain/identity";
import { logServerError } from "@/server/logging/log";
import { subscribeWorld } from "./event-bus";

// 세계관 SSE 스트림 (architecture.md §10.1, Phase 5-3). 런타임 독립(Web ReadableStream).
// - 연결 전에 소유권을 확인한다. 없거나 타인 소유면 NotFoundError(404) — 스트림을 열지 않는다.
// - SSE는 DB의 진실을 전달할 뿐이다. 이벤트 id = SimulationEvent.id. 재연결 시 Last-Event-ID 이후 outbox만 재전송한다.
// - 이 스트림은 Gemini 호출·장면 생성을 시작하지 않는다(생성은 POST /scenes와 Runner).
// - SseConnection 등록부에 연결을 기록한다(A12, 연결마다 행 1개, 10초 heartbeat, 종료 시 삭제).
//   등록 직후·삭제 직후 reconcileClientHold로 SSE 연결 보류를 해제·시작한다(§7.5, Phase 5-4-3). 재연결로 자동 재개하지는 않는다.

const INSTANCE_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const encoder = new TextEncoder();

type StreamOptions = { userId: AuthenticatedUserId; worldId: string; lastEventId: string | null; signal: AbortSignal };

const frame = (id: bigint | null, type: string, data: unknown) =>
  encoder.encode(`${id === null ? "" : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

async function latestEventId(worldId: string): Promise<bigint> {
  const row = await prisma.simulationEvent.findFirst({ where: { worldId }, orderBy: { id: "desc" }, select: { id: true } });
  return row?.id ?? BigInt(0);
}

/** 페이지 렌더 시점의 커서 (첫 SSE 연결의 lastEventId). 기록 조회보다 먼저 읽어 그 사이 커밋된 장면을 놓치지 않는다 */
export async function currentWorldEventCursor(userId: AuthenticatedUserId, worldId: string): Promise<string> {
  await requireOwnedWorld(userId, worldId);
  return String(await latestEventId(worldId));
}

/**
 * 재전송 시작점. 커서가 없으면 지금부터, 형식이 틀리거나 이 세계관의 이벤트가 아니거나(정리됨·위조)
 * 밀린 이벤트가 너무 많으면 sync.required로 전체 재조회를 요청하고 지금부터 받는다.
 */
async function resolveCursor(worldId: string, raw: string | null): Promise<{ cursor: bigint; syncRequired: boolean }> {
  if (raw === null) return { cursor: await latestEventId(worldId), syncRequired: false };
  if (!/^\d{1,19}$/.test(raw)) return { cursor: await latestEventId(worldId), syncRequired: true };
  const cursor = BigInt(raw);
  const known = cursor === BigInt(0) || (await prisma.simulationEvent.count({ where: { worldId, id: cursor } })) === 1;
  const pending = await prisma.simulationEvent.count({ where: { worldId, id: { gt: cursor } } });
  if (!known || pending > SSE_REPLAY_MAX_EVENTS) return { cursor: await latestEventId(worldId), syncRequired: true };
  return { cursor, syncRequired: false };
}

export async function openWorldStream({ userId, worldId, lastEventId, signal }: StreamOptions): Promise<ReadableStream<Uint8Array>> {
  await requireOwnedWorld(userId, worldId);
  const start = await resolveCursor(worldId, lastEventId);
  const connection = await prisma.sseConnection.create({ data: { worldId, userId, instanceId: INSTANCE_ID }, select: { id: true } });
  await reconcileClientHold(worldId).catch((e: unknown) => logServerError("sse.hold-release", e)); // 보류 중이면 해제 (RUNNING 유지)

  let cursor = start.cursor;
  let closed = false;
  let draining: Promise<void> = Promise.resolve();
  const cleanups: (() => void)[] = [];
  const release = () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanups) fn();
    // 마지막 활성 연결이었으면 보류를 시작한다 (다른 탭이 연결돼 있으면 아무것도 바꾸지 않음)
    prisma.sseConnection
      .deleteMany({ where: { id: connection.id } })
      .then(() => reconcileClientHold(worldId))
      .catch((e: unknown) => logServerError("sse.unregister", e));
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: Uint8Array) => {
        if (!closed) controller.enqueue(chunk);
      };
      const close = () => {
        if (closed) return;
        release();
        try {
          controller.close();
        } catch {
          // 이미 닫힘
        }
      };

      // outbox에서 커서 이후 이벤트를 순서대로 보낸다. 직렬화해 같은 이벤트를 두 번 보내지 않는다
      const drain = () => {
        draining = draining.then(async () => {
          for (;;) {
            if (closed) return;
            const rows = await prisma.simulationEvent.findMany({
              where: { worldId, id: { gt: cursor } },
              orderBy: { id: "asc" },
              take: SSE_REPLAY_MAX_EVENTS,
              select: { id: true, type: true, payload: true },
            });
            for (const row of rows) {
              send(frame(row.id, row.type, row.payload));
              cursor = row.id;
            }
            if (rows.length < SSE_REPLAY_MAX_EVENTS) return;
          }
        }).catch((e: unknown) => logServerError("sse.drain", e));
      };

      send(encoder.encode("retry: 3000\n\n"));
      if (start.syncRequired) send(frame(cursor, "sync.required", {}));
      cleanups.push(subscribeWorld(worldId, drain));
      drain();

      const ping = setInterval(() => {
        send(encoder.encode(": ping\n\n"));
        drain(); // 알림이 유실돼도 따라잡는다
      }, SSE_PING_INTERVAL_MS);
      const heartbeat = setInterval(() => {
        prisma.sseConnection
          .updateMany({ where: { id: connection.id }, data: { lastSeenAt: new Date() } })
          .catch((e: unknown) => logServerError("sse.heartbeat", e));
      }, SSE_HEARTBEAT_INTERVAL_MS);
      cleanups.push(() => clearInterval(ping), () => clearInterval(heartbeat));

      if (signal.aborted) close();
      else signal.addEventListener("abort", close, { once: true });
    },
    cancel: release,
  });
}
