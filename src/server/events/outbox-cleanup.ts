import { OUTBOX_RETENTION_MS, SSE_CONNECTION_PURGE_MS } from "../../../config/limits";
import { prisma } from "@/server/db/client";

// outbox·SSE 연결 등록부 정리 (architecture.md §7.5·§10.3, Phase 5-4-3). 런타임 독립.
// - SimulationEvent는 24시간 보관한다(A16). 그보다 오래된 Last-Event-ID로 재연결하면 world-stream이 sync.required를 보낸다.
// - 비정상 종료로 남은 SseConnection 행(활성 판정 30초와 무관하게 10분 넘게 갱신 없음)을 지운다.
// - DB 조건만으로 지우므로 여러 프로세스가 동시에 실행해도 안전하다. 원본(ConversationScene·Message·ApiRequestLog)은 건드리지 않는다.

export async function cleanupExpiredEvents(now: Date = new Date()): Promise<{ events: number; connections: number }> {
  const events = await prisma.simulationEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - OUTBOX_RETENTION_MS) } } });
  const connections = await prisma.sseConnection.deleteMany({ where: { lastSeenAt: { lt: new Date(now.getTime() - SSE_CONNECTION_PURGE_MS) } } });
  return { events: events.count, connections: connections.count };
}
