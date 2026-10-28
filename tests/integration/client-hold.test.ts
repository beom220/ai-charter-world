import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { CLIENT_HOLD_TIMEOUT_MS, OUTBOX_RETENTION_MS } from "../../config/limits";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { reconcileClientHold } from "@/server/domain/simulation/client-hold";
import { runSimulationCommand } from "@/server/domain/simulation/control";
import { runWorldTick, type RunnerContext } from "@/server/engine/runner/world-tick";
import { cleanupExpiredEvents } from "@/server/events/outbox-cleanup";
import { openWorldStream } from "@/server/events/world-stream";
import { createMockGeminiClient, type MockGeminiScript } from "@/server/llm/mock/gemini-mock";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// SSE 연결 보류·장면 이벤트·outbox 정리 (Phase 5-4-3). 실제 DB + Mock Gemini.

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "hold-fingerprint-secret-0123456789",
});

async function setup(label: string, script: MockGeminiScript = {}) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  await saveGeminiApiKey(uid, fakeGeminiKey(label), material);
  await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
  const world = await createTestWorld(user.id, `${label} 세계`);
  for (let i = 0; i < 2; i++) await prisma.character.create({ data: characterData(world.id, `${label}-${i + 1}`) });
  const mock = createMockGeminiClient(script);
  const ctx = (owner = "host-a"): RunnerContext => ({ owner, deps: { client: mock.client, material }, state: { failures: 0 } });
  const command = (c: "start" | "pause" | "resume" | "stop") => runSimulationCommand(uid, world.id, c);
  const connect = (lastSeenAt = new Date()) => prisma.sseConnection.create({ data: { worldId: world.id, userId: user.id, instanceId: "test", lastSeenAt } });
  await command("start");
  return { user, uid, world, mock, ctx, command, connect };
}

const runtime = (worldId: string) => prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId } });
const ago = (ms: number) => new Date(Date.now() - ms);
const eventTypes = async (worldId: string) =>
  (await prisma.simulationEvent.findMany({ where: { worldId }, orderBy: { id: "asc" }, select: { type: true } })).map((e) => e.type);

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** openWorldStream을 열고 받은 이벤트 이름을 모은다 */
async function openStream(userId: string, worldId: string, lastEventId: string | null = null) {
  const abort = new AbortController();
  const stream = await openWorldStream({ userId: asAuthenticatedUserId(userId), worldId, lastEventId, signal: abort.signal });
  const events: string[] = [];
  const reader = new Response(stream).body!.pipeThrough(new TextDecoderStream()).getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done || value === undefined) return;
      for (const m of value.matchAll(/^event: (.+)$/gm)) events.push(m[1]!);
    }
  })();
  return { events, close: () => abort.abort() };
}

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("SSE 연결 보류 (60초 유예)", () => {
  it("SSE 연결은 보류를 해제하고, 마지막 연결이 끊기면 보류를 시작한다. 다른 탭이 남아 있으면 시작하지 않는다", async () => {
    const { user, world, command } = await setup("hold-stream");
    const runId = (await runtime(world.id)).currentRunId;
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { clientHoldSince: ago(10_000) } });

    const tab1 = await openStream(user.id, world.id);
    const tab2 = await openStream(user.id, world.id);
    expect(await runtime(world.id)).toMatchObject({ status: "RUNNING", clientHoldSince: null, currentRunId: runId }); // 재연결: 같은 Run
    await until(() => tab1.events.includes("runtime.status"));

    tab1.close();
    await until(async () => (await prisma.sseConnection.count({ where: { worldId: world.id } })) === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect((await runtime(world.id)).clientHoldSince).toBeNull(); // 다른 탭이 연결돼 있음

    tab2.close();
    await until(async () => (await runtime(world.id)).clientHoldSince !== null);
    const state = await command("start"); // noop → 현재 상태
    expect(state.state).toMatchObject({ status: "RUNNING", held: true });
    expect(state.state.holdDeadline).not.toBeNull();
  });

  it("유예 만료 → PAUSED(CLIENT_DISCONNECTED), 재접속해도 자동 재개하지 않고 resume으로만 재개한다", async () => {
    const { world, command, connect } = await setup("hold-expire");
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { clientHoldSince: ago(CLIENT_HOLD_TIMEOUT_MS - 5_000), leaseOwner: "host-a" } });
    expect(await reconcileClientHold(world.id)).toBe("held"); // 아직 60초 전

    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { clientHoldSince: ago(CLIENT_HOLD_TIMEOUT_MS + 1) } });
    expect(await reconcileClientHold(world.id)).toBe("paused");
    expect(await runtime(world.id)).toMatchObject({ status: "PAUSED", statusReason: "CLIENT_DISCONNECTED", leaseOwner: null, clientHoldSince: null });

    await connect();
    expect(await reconcileClientHold(world.id)).toBe("inactive");
    expect((await runtime(world.id)).status).toBe("PAUSED");
    expect((await command("resume")).state).toMatchObject({ status: "RUNNING", held: false });
  });

  it("사용자 PAUSED·IDLE은 보류 정책이 덮어쓰지 않고, 바뀐 것이 없으면 이벤트도 만들지 않는다", async () => {
    const { world, command } = await setup("hold-manual");
    await command("pause");
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { clientHoldSince: ago(CLIENT_HOLD_TIMEOUT_MS * 2) } });
    const before = await prisma.simulationEvent.count({ where: { worldId: world.id } });
    expect(await reconcileClientHold(world.id)).toBe("inactive");
    expect(await runtime(world.id)).toMatchObject({ status: "PAUSED", statusReason: "USER" });
    await command("stop");
    expect(await reconcileClientHold(world.id)).toBe("inactive");
    expect(await runtime(world.id)).toMatchObject({ status: "IDLE", statusReason: "USER" });
    expect(await prisma.simulationEvent.count({ where: { worldId: world.id } })).toBe(before + 1); // stop의 runtime.status만
  });

  it("재시작: 남은 연결 기록은 무시하고 보류부터 시작해 호출하지 않으며, 60초 뒤 PAUSED로 전이한다", async () => {
    const { world, mock, ctx, connect } = await setup("hold-restart");
    await connect(ago(5 * 60_000)); // 죽은 인스턴스가 남긴 행
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { leaseOwner: "dead:1:x", leaseExpiresAt: ago(1) } });
    expect(await runWorldTick(world.id, ctx("host-new"))).toMatchObject({ kind: "wait" });
    const held = await runtime(world.id);
    expect(held).toMatchObject({ status: "RUNNING", leaseOwner: "host-new" });
    expect(held.clientHoldSince).not.toBeNull();

    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { clientHoldSince: ago(CLIENT_HOLD_TIMEOUT_MS + 1) } });
    await runWorldTick(world.id, ctx("host-new"));
    expect(await runtime(world.id)).toMatchObject({ status: "PAUSED", statusReason: "CLIENT_DISCONNECTED" });
    expect(mock.calls).toHaveLength(0);
  });

  it("진행 중 장면이 있을 때 유예가 만료되면 PAUSING → 장면을 저장한 뒤 PAUSED", async () => {
    const { world, mock, ctx, connect } = await setup("hold-inflight", { delayMs: 300 });
    const tab = await connect();
    const tick = runWorldTick(world.id, ctx());
    await until(() => mock.receivedKeys.length === 1);
    await prisma.sseConnection.delete({ where: { id: tab.id } });
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { clientHoldSince: ago(CLIENT_HOLD_TIMEOUT_MS + 1) } });
    expect(await reconcileClientHold(world.id)).toBe("paused");
    expect((await runtime(world.id)).status).toBe("PAUSING");
    await tick;
    expect(await runtime(world.id)).toMatchObject({ status: "PAUSED", statusReason: "CLIENT_DISCONNECTED", inFlightAttemptId: null });
    expect(await prisma.conversationScene.count({ where: { worldId: world.id } })).toBe(1);
    expect(mock.calls).toHaveLength(1);
  });
});

describe("장면 이벤트·outbox 정리", () => {
  it("실패한 시도는 scene.started → scene.failed(공개 코드만) → runtime.status 순서로 기록된다", async () => {
    const { world, ctx, connect } = await setup("hold-events", { failGenerate: "UPSTREAM_ERROR" });
    await connect();
    await runWorldTick(world.id, ctx());
    expect((await eventTypes(world.id)).slice(-3)).toEqual(["scene.started", "scene.failed", "runtime.status"]);
    const [started, failed] = await prisma.simulationEvent.findMany({ where: { worldId: world.id, type: { in: ["scene.started", "scene.failed"] } }, orderBy: { id: "asc" } });
    const s = started!.payload as { attemptId: string; participants: string[] };
    expect(s.participants).toHaveLength(2);
    expect(failed!.payload).toMatchObject({ worldId: world.id, attemptId: s.attemptId, code: "HTTP_ERROR" });
    expect(Object.keys(failed!.payload as object).sort()).toEqual(["attemptId", "code", "failedAt", "worldId"]);
  });

  it("24시간 지난 outbox만 지우고 장면 원본은 남기며, 지워진 커서로 재연결하면 sync.required", async () => {
    const { user, world, ctx, connect } = await setup("hold-cleanup");
    await connect();
    await runWorldTick(world.id, ctx());
    const old = await prisma.simulationEvent.create({ data: { worldId: world.id, type: "runtime.status", payload: {}, createdAt: ago(OUTBOX_RETENTION_MS + 60_000) } });
    const fresh = await prisma.simulationEvent.count({ where: { worldId: world.id } });

    const removed = await cleanupExpiredEvents();
    expect(removed.events).toBeGreaterThanOrEqual(1);
    expect(await prisma.simulationEvent.count({ where: { id: old.id } })).toBe(0);
    expect(await prisma.simulationEvent.count({ where: { worldId: world.id } })).toBe(fresh - 1);
    expect(await prisma.conversationScene.count({ where: { worldId: world.id } })).toBe(1);

    const stream = await openStream(user.id, world.id, String(old.id));
    await until(() => stream.events.includes("sync.required"));
    stream.close();
  });
});
