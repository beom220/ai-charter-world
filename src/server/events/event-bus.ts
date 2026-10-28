import type { Prisma } from "@/generated/prisma/client";

// EventBus — DB outbox(SimulationEvent) + 프로세스 내 알림 (architecture.md §10.3, A6). 런타임 독립.
// - publish: 상태 커밋과 같은 트랜잭션에서 outbox INSERT. 상태가 바뀌었는데 이벤트가 유실되는 일이 없다.
// - notify: 커밋 후 같은 프로세스의 SSE 구독자를 깨운다. 구독자는 outbox를 다시 읽는다(알림 자체에는 데이터가 없다).
//   알림이 유실되어도 SSE 핸들러가 ping 때마다 outbox를 따라잡는다. 다중 인스턴스는 PG NOTIFY 어댑터로 확장한다(§15).
// payload에는 사용자에게 보여 줄 확정 데이터만 넣는다. API 키·프롬프트·내부 오류 원문은 넣지 않는다.

export type SimEvent = {
  type: "scene.started" | "scene.committed" | "scene.failed" | "runtime.status" | "saves.updated" | "state.replaced" | "world_event.updated";
  payload: Prisma.InputJsonValue;
};

type Listener = () => void;
const registry = ((globalThis as { __simEventListeners?: Map<string, Set<Listener>> }).__simEventListeners ??= new Map());

export async function publishEvents(tx: Prisma.TransactionClient, worldId: string, events: SimEvent[]): Promise<void> {
  if (events.length) await tx.simulationEvent.createMany({ data: events.map((e) => ({ worldId, type: e.type, payload: e.payload })) });
}

export function notifyWorld(worldId: string): void {
  for (const listener of registry.get(worldId) ?? []) listener();
}

export function subscribeWorld(worldId: string, listener: Listener): () => void {
  const set = registry.get(worldId) ?? new Set<Listener>();
  set.add(listener);
  registry.set(worldId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) registry.delete(worldId);
  };
}
