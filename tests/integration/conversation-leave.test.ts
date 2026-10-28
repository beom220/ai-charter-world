import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { leaveConversation } from "@/server/domain/simulation/client-hold";
import { runSimulationCommand } from "@/server/domain/simulation/control";
import { runWorldTick } from "@/server/engine/runner/world-tick";
import { openWorldStream } from "@/server/events/world-stream";
import { createMockGeminiClient } from "@/server/llm/mock/gemini-mock";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// 대화 화면 이탈 시 자동 일시정지 (UI 개선). 실제 DB + Mock Gemini.
// 마지막 대화 화면 연결이 떠나면 바로 PAUSED(진행 중이면 PAUSING → PAUSED), 다른 탭이 남아 있으면 그대로, 돌아와도 자동 재개 없음.

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "leave-fingerprint-secret-0123456789",
});

async function setup(label: string, delayMs = 0) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  await saveGeminiApiKey(uid, fakeGeminiKey(label), material);
  await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
  const world = await createTestWorld(user.id, `${label} 세계`);
  for (let i = 0; i < 2; i++) await prisma.character.create({ data: characterData(world.id, `${label}-${i + 1}`) });
  const tab = () => prisma.sseConnection.create({ data: { worldId: world.id, userId: user.id, instanceId: "test" } });
  const mock = createMockGeminiClient({ delayMs });
  return { user, uid, world, tab, mock, deps: { client: mock.client, material } };
}

const runtime = (worldId: string) => prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId } });
const events = (worldId: string) => prisma.simulationEvent.count({ where: { worldId } });

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("대화 화면 이탈", () => {
  it("다른 대화 탭이 남아 있으면 유지, 마지막 탭이 떠나면 바로 PAUSED이고 다시 접속해도 자동 재개하지 않는다", async () => {
    const { uid, world, tab } = await setup("leave-tabs");
    const a = await tab();
    const b = await tab();
    await runSimulationCommand(uid, world.id, "start");
    const runId = (await runtime(world.id)).currentRunId;

    expect(await leaveConversation(uid, world.id, a.id)).toBe("connected");
    expect(await runtime(world.id)).toMatchObject({ status: "RUNNING", clientHoldSince: null });
    expect(await prisma.sseConnection.count({ where: { worldId: world.id } })).toBe(1);

    expect(await leaveConversation(uid, world.id, b.id)).toBe("paused");
    expect(await runtime(world.id)).toMatchObject({ status: "PAUSED", statusReason: "CLIENT_DISCONNECTED", leaseOwner: null, clientHoldSince: null, currentRunId: runId });

    // 대화 화면으로 돌아옴(새 연결) → PAUSED 유지
    const abort = new AbortController();
    await openWorldStream({ userId: uid, worldId: world.id, lastEventId: null, signal: abort.signal });
    expect((await runtime(world.id)).status).toBe("PAUSED");
    abort.abort();
  });

  it("이미 IDLE·PAUSED면 바꾸지 않고 이벤트도 없다. 타인 세계관은 404이고 남의 연결은 지우지 못한다", async () => {
    const { uid, world, tab } = await setup("leave-noop");
    const other = await setup("leave-other");
    const mine = await tab();
    const before = await events(world.id);
    expect(await leaveConversation(uid, world.id, mine.id)).toBe("inactive");
    await runSimulationCommand(uid, world.id, "start");
    await runSimulationCommand(uid, world.id, "pause");
    const paused = await events(world.id);
    expect(await leaveConversation(uid, world.id, null)).toBe("inactive");
    expect(await events(world.id)).toBe(paused);
    expect(paused).toBeGreaterThan(before);

    const theirs = await other.tab();
    await expect(leaveConversation(uid, other.world.id, theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await leaveConversation(uid, world.id, theirs.id)).toBe("inactive"); // 다른 세계관의 연결 ID → 지우지 않음
    expect(await prisma.sseConnection.count({ where: { id: theirs.id } })).toBe(1);
  });

  it("생성 중 장면이 있으면 PAUSING → 장면을 저장한 뒤 PAUSED, 그 뒤 새 호출은 없다", async () => {
    const { uid, world, tab, mock, deps } = await setup("leave-inflight", 300);
    const only = await tab();
    await runSimulationCommand(uid, world.id, "start");
    const tick = runWorldTick(world.id, { owner: "host-a", deps, state: { failures: 0 } });
    while (mock.receivedKeys.length === 0) await new Promise((r) => setTimeout(r, 10));
    expect(await leaveConversation(uid, world.id, only.id)).toBe("paused");
    expect((await runtime(world.id)).status).toBe("PAUSING");
    await tick;
    expect(await runtime(world.id)).toMatchObject({ status: "PAUSED", inFlightAttemptId: null });
    expect(await prisma.conversationScene.count({ where: { worldId: world.id } })).toBe(1);
    expect(await runWorldTick(world.id, { owner: "host-a", deps, state: { failures: 0 } })).toEqual({ kind: "exit" });
    expect(mock.calls).toHaveLength(1);
  });

  it("보기 전용 구독(캐릭터 상세)은 대화 화면 연결로 세지 않아, 그것만 남으면 실행이 보류된다", async () => {
    const { uid, world } = await setup("leave-watch");
    await runSimulationCommand(uid, world.id, "start");
    const abort = new AbortController();
    await openWorldStream({ userId: uid, worldId: world.id, lastEventId: null, signal: abort.signal, presence: false });
    expect(await prisma.sseConnection.count({ where: { worldId: world.id } })).toBe(0);
    expect(await leaveConversation(uid, world.id, null)).toBe("paused");
    abort.abort();
  });
});
