import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { SCENE_IN_FLIGHT_STALE_MS } from "../../config/limits";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { generateScene } from "@/server/domain/scenes/generate-scene";
import { runSimulationCommand } from "@/server/domain/simulation/control";
import { InProcessRunnerHost } from "@/server/engine/runner/host";
import { registerRunnerHost } from "@/server/engine/runner/signal";
import { runWorldTick, type RunnerContext } from "@/server/engine/runner/world-tick";
import { createMockGeminiClient, type MockGeminiScript } from "@/server/llm/mock/gemini-mock";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// 자동 실행 Runner (Phase 5-4-2). 실제 DB + Mock Gemini. lease·진행 중 시도·펜싱·한도·실패 간격·재시작 복구.

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "runner-fingerprint-secret-0123456789",
});

const T0 = Date.parse("2026-10-28T03:00:00.000Z");
const ALWAYS_ACTIVE = new Date("2100-01-01T00:00:00.000Z");

async function setup(label: string, script: MockGeminiScript = {}) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  await saveGeminiApiKey(uid, fakeGeminiKey(label), material);
  await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
  const world = await createTestWorld(user.id, `${label} 세계`);
  for (let i = 0; i < 2; i++) await prisma.character.create({ data: characterData(world.id, `${label}-${i + 1}`) });
  // 브라우저 탭 1개가 연결된 상태 (테스트 시계와 무관하게 활성). 보류 정책은 client-hold.test.ts에서 따로 본다
  await prisma.sseConnection.create({ data: { worldId: world.id, userId: user.id, instanceId: "test", lastSeenAt: ALWAYS_ACTIVE } });
  const mock = createMockGeminiClient(script);
  const clock = { ms: T0 };
  const deps = { client: mock.client, material, now: () => new Date(clock.ms) };
  const ctx = (owner = "host-a"): RunnerContext => ({ owner, deps, state: { failures: 0 } });
  const command = (c: "start" | "pause" | "resume" | "stop") => runSimulationCommand(uid, world.id, c, deps.now);
  await command("start");
  return { user, uid, world, mock, clock, deps, ctx, command };
}

const runtime = (worldId: string) => prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId } });
const sceneCount = (worldId: string) => prisma.conversationScene.count({ where: { worldId } });

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterAll(async () => {
  registerRunnerHost(undefined);
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("Runner 단계 (runWorldTick)", () => {
  it("RUNNING이면 장면을 만들고 재생 시간 기준으로 다음 장면을 예약한다. 예정 전에는 호출하지 않고, 수동 생성은 막힌다", async () => {
    const { uid, world, mock, clock, deps, ctx } = await setup("run-auto");
    const runner = ctx();
    expect(await runWorldTick(world.id, runner)).toEqual({ kind: "wait", ms: 0 });

    const run = await prisma.simulationRun.findFirstOrThrow({ where: { worldId: world.id } });
    const scenes = await prisma.conversationScene.findMany({ where: { worldId: world.id } });
    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({ seq: 1, runId: run.id });
    // 3턴 × (쉼 900 + 입력 중 3000) = 11.7초 > NORMAL 5초
    expect(await runtime(world.id)).toMatchObject({ status: "RUNNING", inFlightAttemptId: null, leaseOwner: "host-a", nextSceneAt: new Date(T0 + 11_700) });
    expect(await prisma.simulationRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ requestCount: 1, successCount: 1 });
    const types = (await prisma.simulationEvent.findMany({ where: { worldId: world.id }, orderBy: { id: "asc" } })).map((e) => e.type);
    expect(types).toEqual(["runtime.status", "scene.started", "scene.committed", "runtime.status"]);

    // 예정 시각 전: 대기만 한다. 실행 중 수동 생성은 409
    expect(await runWorldTick(world.id, runner)).toMatchObject({ kind: "wait" });
    await expect(generateScene(uid, world.id, deps)).rejects.toMatchObject({ status: 409, code: "SCENE_IN_PROGRESS" });
    expect(mock.calls).toHaveLength(1);

    clock.ms = T0 + 11_700;
    await runWorldTick(world.id, runner);
    expect(mock.calls).toHaveLength(2);
    expect(await sceneCount(world.id)).toBe(2);
  });

  it("같은 세계관에 Runner 2개가 동시에 접근해도 호출은 1번, 다른 세계관은 독립적으로 진행한다", async () => {
    const a = await setup("run-race", { delayMs: 50 });
    const b = await setup("run-race-other", { delayMs: 50 });
    await Promise.all([runWorldTick(a.world.id, a.ctx("host-a")), runWorldTick(a.world.id, a.ctx("host-b")), runWorldTick(b.world.id, b.ctx("host-a"))]);
    expect(a.mock.calls).toHaveLength(1);
    expect(await sceneCount(a.world.id)).toBe(1);
    expect(await prisma.simulationEvent.count({ where: { worldId: a.world.id, type: "scene.started" } })).toBe(1);
    expect(b.mock.calls).toHaveLength(1);
    expect(await sceneCount(b.world.id)).toBe(1);
  });

  it("PAUSED·삭제된 세계관에서는 호출하지 않고 종료한다", async () => {
    const { world, mock, ctx, command } = await setup("run-paused");
    await command("pause");
    expect(await runWorldTick(world.id, ctx())).toEqual({ kind: "exit" });
    await command("resume");
    await prisma.world.delete({ where: { id: world.id } });
    expect(await runWorldTick(world.id, ctx())).toEqual({ kind: "exit" });
    expect(mock.calls).toHaveLength(0);
  });

  it("진행 중 pause → PAUSING, 진행 중 장면은 저장하고 PAUSED로 전이한다", async () => {
    const { world, mock, ctx, command } = await setup("run-pausing", { delayMs: 300 });
    const tick = runWorldTick(world.id, ctx());
    await until(() => mock.receivedKeys.length === 1);
    expect((await command("pause")).state.status).toBe("PAUSING");
    await tick;
    expect(await runtime(world.id)).toMatchObject({ status: "PAUSED", inFlightAttemptId: null, leaseOwner: null, nextSceneAt: null });
    expect(await sceneCount(world.id)).toBe(1);
    expect(await runWorldTick(world.id, ctx())).toEqual({ kind: "exit" });
    expect(mock.calls).toHaveLength(1);
  });

  it("진행 중 stop → 늦게 도착한 결과는 저장하지 않고 진행 중 표시를 정리한다", async () => {
    const { world, mock, ctx, command } = await setup("run-stop", { delayMs: 300 });
    const tick = runWorldTick(world.id, ctx());
    await until(() => mock.receivedKeys.length === 1);
    await command("stop");
    await tick;
    expect(mock.calls).toHaveLength(1);
    expect(await sceneCount(world.id)).toBe(0);
    expect(await runtime(world.id)).toMatchObject({ status: "IDLE", inFlightAttemptId: null, leaseOwner: null });
    expect((await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } })).nextSceneSeq).toBe(1);
  });

  it("lease 만료·재시작: 남은 진행 중 시도는 재시도하지 않고, 결과 불확실 기간이 지난 뒤 새 장면을 간격 뒤에 시작한다", async () => {
    const { world, mock, clock, ctx } = await setup("run-recover");
    await prisma.simulationRuntime.update({
      where: { worldId: world.id },
      data: { leaseOwner: "dead-host:1:x", leaseExpiresAt: new Date(T0 - 1), inFlightAttemptId: "lost-attempt", inFlightStartedAt: new Date(T0) },
    });
    const restarted = ctx("host-new");
    clock.ms = T0 + 31_000;
    expect(await runWorldTick(world.id, restarted)).toMatchObject({ kind: "wait" });
    expect(await runtime(world.id)).toMatchObject({ leaseOwner: "host-new", inFlightAttemptId: "lost-attempt" });

    clock.ms = T0 + SCENE_IN_FLIGHT_STALE_MS + 1;
    await runWorldTick(world.id, restarted);
    const rt = await runtime(world.id);
    expect(rt).toMatchObject({ status: "RUNNING", inFlightAttemptId: null });
    expect(rt.nextSceneAt!.getTime()).toBe(clock.ms + 5_000);
    expect(mock.calls).toHaveLength(0);

    clock.ms += 5_000;
    await runWorldTick(world.id, restarted);
    expect(mock.calls).toHaveLength(1);
    expect(await sceneCount(world.id)).toBe(1);
  });

  it("일일 한도에 도달하면 호출하지 않고 PAUSED(USAGE_LIMIT), 브레이커가 열려 있으면 RUNNING을 유지하고 blockedUntil까지 미룬다", async () => {
    const limited = await setup("run-limit");
    await prisma.aiProviderConnection.updateMany({ where: { userId: limited.user.id }, data: { dailyRequestLimit: 0 } });
    expect(await runWorldTick(limited.world.id, limited.ctx())).toMatchObject({ kind: "wait" });
    expect(await runtime(limited.world.id)).toMatchObject({ status: "PAUSED", statusReason: "USAGE_LIMIT", leaseOwner: null });
    expect(await runWorldTick(limited.world.id, limited.ctx())).toEqual({ kind: "exit" });
    expect(limited.mock.calls).toHaveLength(0);

    const blocked = await setup("run-breaker");
    const until = new Date(T0 + 60_000);
    await prisma.aiProviderConnection.updateMany({ where: { userId: blocked.user.id }, data: { blockedUntil: until, backoffLevel: 1, blockReason: "RATE_LIMIT" } });
    await runWorldTick(blocked.world.id, blocked.ctx());
    expect(await runtime(blocked.world.id)).toMatchObject({ status: "RUNNING", nextSceneAt: until });
    expect(blocked.mock.calls).toHaveLength(0);
  });

  it("장면 실패는 다시 보내지 않고, 연속 실패마다 다음 시도 간격을 늘린다", async () => {
    const { world, mock, clock, ctx } = await setup("run-fail", { failGenerate: "UPSTREAM_ERROR" });
    const runner = ctx();
    await runWorldTick(world.id, runner);
    expect(mock.calls).toHaveLength(1);
    expect((await runtime(world.id)).nextSceneAt).toEqual(new Date(T0 + 5_000));
    await runWorldTick(world.id, runner); // 예정 전: 호출 없음
    expect(mock.calls).toHaveLength(1);

    clock.ms = T0 + 5_000;
    await runWorldTick(world.id, runner);
    expect(mock.calls).toHaveLength(2);
    expect((await runtime(world.id)).nextSceneAt).toEqual(new Date(T0 + 15_000));
    expect(await sceneCount(world.id)).toBe(0);
    expect(await runtime(world.id)).toMatchObject({ status: "RUNNING", inFlightAttemptId: null });
  });
});

describe("RunnerHost", () => {
  it("start 신호로 Runner를 붙여 장면을 만들고, pause 후 Runner가 종료되며 shutdown이 lease를 정리한다", async () => {
    const { uid, world, mock, deps, command } = await setup("run-host");
    await command("stop"); // 신호 경로를 확인하려고 호스트 등록 후 다시 시작한다
    const host = new InProcessRunnerHost({ owner: "host-test", deps: { client: deps.client, material } });
    registerRunnerHost(host);
    try {
      await runSimulationCommand(uid, world.id, "start");
      await until(async () => (await sceneCount(world.id)) === 1);
      expect(host.activeWorldIds()).toEqual([world.id]);
      await runSimulationCommand(uid, world.id, "pause");
      await until(() => host.activeWorldIds().length === 0);
      expect(mock.calls).toHaveLength(1);
    } finally {
      registerRunnerHost(undefined);
      await host.shutdown();
    }
    expect(await runtime(world.id)).toMatchObject({ status: "PAUSED", leaseOwner: null });
  });
});
