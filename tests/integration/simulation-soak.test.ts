import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { EXTREME_LETHAL_WORLD_SECONDS, EXTREME_LIFE_RISK_WORLD_SECONDS, INJURY_NATURAL_RECOVERY_WORLD_SECONDS } from "../../config/limits";
import { realMsForWorldSeconds, worldSecondsForRealMs } from "@/lib/world-clock";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { cancelUserEvent, submitUserEvent } from "@/server/domain/events/user-events";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { loadSave, runAutoSave } from "@/server/domain/saves/saves";
import { reconcileClientHold } from "@/server/domain/simulation/client-hold";
import { runSimulationCommand } from "@/server/domain/simulation/control";
import { touchWorldClock } from "@/server/domain/simulation/world-clock";
import { runWorldTick, type RunnerContext } from "@/server/engine/runner/world-tick";
import type { GeminiErrorKind, GeminiKeyClient } from "@/server/llm/gemini/client";
import { createMockGeminiClient, type MockGeminiScript } from "@/server/llm/mock/gemini-mock";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// 여러 시스템이 함께 도는 자동 시뮬레이션 연속 실행 (실행 제어·월드 시계·연결 보류·자동/사용자 사건·기억·신체 상태·저장/불러오기·실패·lease).
// 실제 DB + Mock Gemini + 가짜 시계. Runner 단계(runWorldTick)를 직접 돌려 실제 시간을 기다리지 않는다. 테스트 사용자만 만들고 지운다.

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "simulation-soak-fingerprint-0123456789",
});
const T0 = Date.parse("2026-10-28T03:00:00.000Z");
const FOREVER = new Date("2100-01-01T00:00:00.000Z");

/** 결정적 난수 (mulberry32) */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gemini 요청 1건에서 읽은 것: 참가자 별칭 → 이름, 이번 장면 사건 별칭, 프롬프트 원문 */
type Call = { prompt: string; names: Map<string, string>; events: string[] };
type Reply = { fail?: GeminiErrorKind; text?: string; conditions?: unknown[]; during?: () => Promise<void> };

function parseCall(prompt: string): Call {
  const names = new Map([...prompt.matchAll(/<character alias="(C\d)">\n이름: ([^\n]+)/g)].map((m) => [m[1]!, m[2]!]));
  const block = prompt.match(/<events>[\s\S]*?<\/events>/)?.[0] ?? "";
  return { prompt, names, events: [...block.matchAll(/^\[(E\d)\]/gm)].map((m) => m[1]!) };
}

/** 첫 참가자가 사건마다 그 사건 기억(eventRef)을 내는 올바른 장면. 나머지 참가자의 사건 기억은 서버 보완에 맡긴다 */
function sceneJson(call: Call, n: number, conditions: unknown[] = []): string {
  const [a, b] = [...call.names.keys()];
  return JSON.stringify({
    scene: { title: `장면 ${n}`, summary: `요약 ${n}`, endReason: "RESOLVED" },
    turns: [
      { speaker: a, dialogue: `대사 ${n}-1`, actionIntent: null, emotionCue: null },
      { speaker: b, dialogue: `대사 ${n}-2`, actionIntent: null, emotionCue: null },
      { speaker: a, dialogue: `대사 ${n}-3`, actionIntent: null, emotionCue: null },
    ],
    proposals: {
      emotions: [],
      relationships: [{ from: a, to: b, affinity: 9, trust: 1, respect: 0, familiarity: 1, reason: "대화" }],
      memories: call.events.map((e) => ({ owner: a, about: null, kind: "EVENT", acquisition: "WITNESSED", content: `${e} 사건을 겪었다 (${n})`, importance: 3, eventRef: e })),
    },
    events: call.events.map((ref) => ({ ref, realization: null, usedFallback: false, danger: "NONE" })),
    conditions,
  });
}

async function setup(label: string, characters: number, seed: number) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  await saveGeminiApiKey(uid, fakeGeminiKey(label), material);
  await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
  const world = await createTestWorld(user.id, `${label} 세계`);
  const chars = [];
  for (let i = 0; i < characters; i++) {
    const c = await prisma.character.create({ data: characterData(world.id, `${label}-${i + 1}`) });
    await prisma.characterCondition.create({ data: { characterId: c.id, worldId: world.id } });
    chars.push(c);
  }
  const connect = () => prisma.sseConnection.create({ data: { worldId: world.id, userId: user.id, instanceId: "tab-1", lastSeenAt: FOREVER } });
  const disconnect = () => prisma.sseConnection.deleteMany({ where: { worldId: world.id } });
  await connect();

  const clock = { ms: T0 };
  const calls: Call[] = [];
  const script: MockGeminiScript = {};
  const mock = createMockGeminiClient(script);
  const plan: { next: (call: Call, n: number) => Reply } = { next: () => ({}) };
  const client: GeminiKeyClient = {
    ...mock.client,
    generateJson: async (apiKey, request, meter) => {
      const call = parseCall(request.prompt);
      calls.push(call);
      const reply = plan.next(call, calls.length);
      script.failGenerate = reply.fail;
      script.generateText = reply.text ?? sceneJson(call, calls.length, reply.conditions);
      // during: 요청 직전 재검증·사용량 예약을 통과해 요청이 나간 뒤(응답 전)에 할 일
      return mock.client.generateJson(apiKey, request, async (req) => {
        const settle = await meter(req);
        await reply.during?.();
        return settle;
      });
    },
  };
  const deps = { client, material, now: () => new Date(clock.ms), random: seeded(seed) };
  const ctx = (owner = "host-a"): RunnerContext => ({ owner, deps, state: { failures: 0 } });
  const command = (c: "start" | "pause" | "resume" | "stop") => runSimulationCommand(uid, world.id, c, deps.now);
  const runtime = () => prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId: world.id } });
  const gameState = () => prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } });
  /** RUNNING 중 시계를 앞으로 옮긴다. Runner처럼 30초 확인 간격 안에서 월드 시계를 확인한다 */
  const advance = async (ms: number) => {
    const end = clock.ms + ms;
    while (clock.ms < end) {
      clock.ms = Math.min(end, clock.ms + 20_000);
      await touchWorldClock(world.id, new Date(clock.ms));
    }
  };
  /** 다음 예정 시각까지 시계를 옮기고 Runner 한 단계 */
  const step = async (runner: RunnerContext) => {
    const due = (await runtime()).nextSceneAt?.getTime() ?? clock.ms;
    if (due > clock.ms) await advance(due - clock.ms);
    return runWorldTick(world.id, runner);
  };
  return { user, uid, world, chars, clock, calls, plan, deps, ctx, command, runtime, gameState, advance, step, connect, disconnect };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** 공통 불변식: 장면 seq 연속, 장면 = 성공 호출, 호출 = 사용량 기록 = scene.started, 사건별 기억은 참가자마다 정확히 1개(비참가자 0) */
async function assertInvariants(s: Setup) {
  const worldId = s.world.id;
  const scenes = await prisma.conversationScene.findMany({ where: { worldId }, orderBy: { seq: "asc" }, select: { id: true, seq: true, attemptId: true } });
  expect(scenes.map((x) => x.seq)).toEqual(scenes.map((_, i) => i + 1));
  expect(new Set(scenes.map((x) => x.attemptId)).size).toBe(scenes.length);
  expect((await s.gameState()).nextSceneSeq).toBe(scenes.length + 1);
  const logs = await prisma.apiRequestLog.count({ where: { userId: s.user.id, attemptId: { not: null } } });
  expect(logs).toBe(s.calls.length);

  const events = await prisma.worldEvent.findMany({ where: { worldId, status: "RESOLVED" }, select: { id: true, sourceSceneId: true, startedSceneSeq: true } });
  for (const e of events) {
    const participants = await prisma.sceneParticipant.findMany({ where: { sceneId: e.sourceSceneId! }, select: { characterId: true } });
    const memories = await prisma.characterMemory.findMany({ where: { worldId, shareGroupId: e.id }, select: { ownerCharacterId: true } });
    expect(memories.map((m) => m.ownerCharacterId).sort()).toEqual(participants.map((p) => p.characterId).sort());
  }
  // 자동 사건: 구간당 1행, 발생한 구간은 예약 장면에서 정확히 1번
  const periods = await prisma.worldEventPeriod.findMany({ where: { worldId }, orderBy: { periodIndex: "asc" } });
  expect(periods.map((p) => p.periodIndex)).toEqual(periods.map((_, i) => i));
  const random = await prisma.worldEvent.findMany({ where: { worldId, kind: "RANDOM" }, select: { id: true, startedSceneSeq: true } });
  const fired = periods.filter((p) => p.firedAt);
  expect(random).toHaveLength(fired.length);
  for (const p of fired) expect(random.find((e) => e.id === p.eventId)?.startedSceneSeq).toBe(p.scheduledSceneSeq);
  for (const p of periods.filter((x) => !x.won)) expect(p.firedAt).toBeNull();
  return { scenes, events, periods };
}

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("장시간 자동 실행 (가짜 시계)", () => {
  it("일시정지·재개·연결 보류·Gemini 실패·사용자 사건·자동 저장/불러오기를 섞어 50장면을 돌려도 상태가 중복·누락 없이 이어진다", async () => {
    const s = await setup("soak-long", 4, 7);
    const runner = s.ctx();
    const flows: [number, number][] = []; // 월드 시계가 흐른 실제 구간
    let flowStart = s.clock.ms;
    const flowStop = () => flows.push([flowStart, s.clock.ms]);
    const failures = new Set([6, 17, 29]); // 호출 번호 → 503 (재시도 없음)
    const invalid = new Set([12]); // 검증 실패
    const userTexts = ["마을 우물이 말라 버렸다", "낯선 상인이 마을에 도착했다", "취소될 사건"];
    const userEvents: string[] = [];
    let cancelTried = false;
    let pauseDuringCall = false;
    s.plan.next = (call, n) => {
      if (failures.has(n)) return { fail: "UPSTREAM_ERROR" };
      if (invalid.has(n)) return { text: "{\"scene\":" };
      // 사건이 점유된 시도 중에는 그 사건을 취소할 수 없다
      if (call.prompt.includes(userTexts[0]!) && !cancelTried) {
        cancelTried = true;
        return {
          during: async () => {
            await expect(cancelUserEvent(s.uid, s.world.id, userEvents[0]!, new Date(s.clock.ms))).rejects.toMatchObject({ code: "USER_EVENT_IN_PROGRESS" });
          },
        };
      }
      // 호출 중 일시정지: 진행 중 장면은 저장하고(PAUSING) 그 뒤 PAUSED, 월드 시계는 일시정지 시각에 멈춘다
      if (n === 40 && !pauseDuringCall) {
        pauseDuringCall = true;
        return {
          during: async () => {
            expect((await s.command("pause")).state.status).toBe("PAUSING");
            flowStop();
          },
        };
      }
      return {};
    };

    await s.command("start");
    let autoSaveId: string | null = null;
    let scenesAtAutoSave = 0;
    for (let guard = 0; guard < 400 && (await prisma.conversationScene.count({ where: { worldId: s.world.id } })) < 50; guard++) {
      const scenes = await prisma.conversationScene.count({ where: { worldId: s.world.id } });
      const rt = await s.runtime();
      if (rt.status === "PAUSED") {
        // 호출 중 일시정지 후: 1시간 쉬었다가 재개 (쉬는 동안 월드 시간은 흐르지 않는다)
        expect(rt).toMatchObject({ statusReason: "USER", leaseOwner: null, inFlightAttemptId: null, clockAnchorAt: null });
        s.clock.ms += 3_600_000;
        await s.command("resume");
        flowStart = s.clock.ms;
        continue;
      }
      if (scenes === 5 && flows.length === 0) {
        // 대기 중 일시정지 → 10분 뒤 재개 (중복 명령은 noop)
        await Promise.all([s.command("pause"), s.command("pause")]);
        flowStop();
        s.clock.ms += 600_000;
        const resumed = await Promise.all([s.command("resume"), s.command("resume")]);
        expect(resumed.filter((r) => r.changed)).toHaveLength(1);
        flowStart = s.clock.ms;
        continue;
      }
      if (scenes === 5 && userEvents.length === 0) {
        // 두 탭에서 같은 요청을 동시에 보내도 사건은 하나, 30초 뒤 두 번째·세 번째 사건
        const at = (dt: number) => new Date(s.clock.ms + dt);
        const [a, b] = await Promise.all([0, 1].map(() => submitUserEvent(s.uid, s.world.id, { text: userTexts[0]!, requestId: "soak-req-1" }, at(0))));
        expect([a!.created, b!.created].filter(Boolean)).toHaveLength(1);
        userEvents.push(a!.event.id);
        userEvents.push((await submitUserEvent(s.uid, s.world.id, { text: userTexts[1]!, requestId: "soak-req-2" }, at(30_000))).event.id);
        userEvents.push((await submitUserEvent(s.uid, s.world.id, { text: userTexts[2]!, requestId: "soak-req-3" }, at(60_000))).event.id);
        await cancelUserEvent(s.uid, s.world.id, userEvents[2]!, at(60_000)); // 아직 점유 전: 취소된다
        continue;
      }
      if (scenes === 20 && flows.length === 1) {
        // 마지막 탭이 닫힘 → 보류(호출 없음, 시계 멈춤) → 40초 뒤 다시 연결 → 이어서 실행
        await s.disconnect();
        const before = s.calls.length;
        await runWorldTick(s.world.id, runner);
        expect((await s.runtime()).clientHoldSince).not.toBeNull();
        flowStop();
        s.clock.ms += 40_000;
        await runWorldTick(s.world.id, runner);
        expect(s.calls.length).toBe(before);
        await s.connect();
        expect(await reconcileClientHold(s.world.id, new Date(s.clock.ms))).toBe("connected");
        flowStart = s.clock.ms;
        continue;
      }
      if (scenes === 30 && !autoSaveId) {
        // 실행 중 자동 저장 (예정 시각 도달)
        await prisma.simulationRuntime.update({ where: { worldId: s.world.id }, data: { nextAutoSaveAt: new Date(s.clock.ms) } });
        expect(await runAutoSave(s.world.id, new Date(s.clock.ms))).toBe("saved");
        autoSaveId = (await prisma.saveGame.findFirstOrThrow({ where: { worldId: s.world.id, kind: "AUTO" } })).id;
        scenesAtAutoSave = scenes;
      }
      await s.step(runner);
    }
    await s.command("pause");
    flowStop();

    const { scenes, periods } = await assertInvariants(s);
    expect(scenes).toHaveLength(50);
    expect(s.calls.length).toBe(50 + failures.size + invalid.size); // 실패한 장면은 다시 보내지 않는다
    expect(await prisma.simulationEvent.count({ where: { worldId: s.world.id, type: "scene.started" } })).toBe(s.calls.length);
    expect(await prisma.simulationEvent.count({ where: { worldId: s.world.id, type: "scene.failed" } })).toBe(failures.size + invalid.size);
    expect(await prisma.simulationRun.count({ where: { worldId: s.world.id } })).toBe(1); // 일시정지·재개·보류는 새 Run을 만들지 않는다

    // 월드 시계: 흐른 구간만 × 36 (일시정지·보류 구간 제외, 정산 단위 반올림 오차만 허용)
    const expected = flows.reduce((sum, [a, b]) => sum + worldSecondsForRealMs(b - a), 0);
    expect(Math.abs((await s.gameState()).worldSeconds - expected)).toBeLessThanOrEqual(flows.length);

    // 자동 사건: #3~#22, #23~#42 두 구간과 #43~ 구간이 각각 한 번만 판정되고, 최근 프리셋은 겹치지 않는다
    expect(periods.map((p) => p.periodIndex)).toEqual([0, 1, 2]);
    const presets = (await prisma.worldEvent.findMany({ where: { worldId: s.world.id, kind: "RANDOM" }, select: { presetId: true } })).map((e) => e.presetId);
    expect(new Set(presets).size).toBe(presets.length);

    // 사용자 사건: 등록 순으로 한 번씩 발생, 취소된 사건은 어떤 프롬프트에도 없다, 발생 뒤 다시 주입되지 않는다
    const [u1, u2, u3] = await Promise.all(userEvents.map((id) => prisma.worldEvent.findUniqueOrThrow({ where: { id } })));
    expect(u1).toMatchObject({ status: "RESOLVED", claimedAttemptId: null });
    expect(u2).toMatchObject({ status: "RESOLVED", claimedAttemptId: null });
    expect(u2!.startedSceneSeq).toBeGreaterThan(u1!.startedSceneSeq!);
    expect(u3).toMatchObject({ status: "CANCELLED" });
    // 첫 사용자 사건은 503으로 실패한 시도에서 풀렸다가, 다음 시도에서 예약된 자동 사건과 같은 장면에 함께 발생한다 (기억은 위 불변식에서 사건×참가자 1개씩)
    expect(await prisma.worldEvent.count({ where: { worldId: s.world.id, kind: "RANDOM", startedSceneSeq: u1!.startedSceneSeq } })).toBe(1);
    expect(s.calls.some((c) => c.prompt.includes(userTexts[2]!))).toBe(false);
    const eventsBlock = (c: Call) => c.prompt.match(/<events>[\s\S]*?<\/events>/)?.[0] ?? "";
    const failed = (i: number) => failures.has(i + 1) || invalid.has(i + 1);
    const injected = (text: string) => s.calls.flatMap((c, i) => (eventsBlock(c).includes(text) ? [i] : []));
    for (const text of userTexts.slice(0, 2)) expect(injected(text).filter((i) => !failed(i))).toHaveLength(1); // 실패한 시도에서만 다시 주입
    const u1Index = injected(userTexts[0]!).at(-1)!;

    // 이야기 연속성: 사건 장면 다음 프롬프트의 기록에 그 장면이 있고, 사건을 겪은 인물이 다시 나오면 그 사건 기억이 프롬프트에 들어간다
    const u1Scene = scenes.find((x) => x.seq === u1!.startedSceneSeq)!;
    const nextCall = s.calls.find((c) => c.prompt.includes(`[장면 #${u1Scene.seq}] 장면`));
    expect(nextCall).toBeDefined();
    const witnesses = await prisma.sceneParticipant.findMany({ where: { sceneId: u1Scene.id }, select: { nameSnapshot: true } });
    const later = s.calls.slice(u1Index + 1);
    const withWitness = later.find((c) => [...c.names.values()].some((name) => witnesses.some((w) => w.nameSnapshot === name)));
    expect(withWitness?.prompt).toMatch(/E\d 사건을 겪었다|이 사건을 직접 겪었다/);

    // 저장 → 종료 → 불러오기: 저장 시점 장면 수·사건 구간으로 되돌리고, 다시 시작하면 seq·구간 판정이 이어진다(재추첨 없음)
    await s.command("stop");
    await loadSave(s.uid, s.world.id, autoSaveId!, new Date(s.clock.ms));
    expect(await prisma.conversationScene.count({ where: { worldId: s.world.id } })).toBe(scenesAtAutoSave);
    const restoredPeriods = await prisma.worldEventPeriod.findMany({ where: { worldId: s.world.id }, orderBy: { periodIndex: "asc" } });
    expect(restoredPeriods.map((p) => [p.periodIndex, p.won, p.scheduledSceneSeq])).toEqual(
      periods.filter((p) => p.periodIndex <= 1).map((p) => [p.periodIndex, p.won, p.scheduledSceneSeq]),
    );
    await s.command("start");
    s.calls.length = 0;
    s.plan.next = () => ({});
    const restarted = s.ctx("host-restarted");
    for (let i = 0; i < 3; i++) await s.step(restarted);
    expect(await prisma.conversationScene.count({ where: { worldId: s.world.id } })).toBe(scenesAtAutoSave + 3);
  });
});

describe("다중 Runner·중복 요청", () => {
  it("두 호스트가 동시에 돌고 lease가 넘어가도 장면·사건·기억이 한 번씩만 반영되고, 늦은 결과는 버려진다", async () => {
    const s = await setup("soak-hosts", 3, 11);
    const a = s.ctx("host-a");
    const b = s.ctx("host-b");
    await s.command("start");
    // 두 호스트가 매 단계 동시에 깨어난다
    for (let i = 0; i < 12; i++) {
      const due = (await s.runtime()).nextSceneAt?.getTime() ?? s.clock.ms;
      if (due > s.clock.ms) await s.advance(due - s.clock.ms);
      await Promise.all([runWorldTick(s.world.id, a), runWorldTick(s.world.id, b)]);
    }
    expect(s.calls).toHaveLength(12);

    // host-a 호출 중 lease가 만료되어 host-b가 가져감 → host-a 결과는 저장하지 않고, 점유했던 사용자 사건은 다음 시도가 한 번만 발생시킨다
    const { event } = await submitUserEvent(s.uid, s.world.id, { text: "다리가 무너졌다", requestId: "soak-hosts-1" }, new Date(s.clock.ms));
    let stolen = false;
    s.plan.next = () =>
      stolen
        ? {}
        : {
            during: async () => {
              stolen = true;
              await prisma.simulationRuntime.update({ where: { worldId: s.world.id }, data: { leaseExpiresAt: new Date(s.clock.ms - 1) } });
              expect(await runWorldTick(s.world.id, b)).toMatchObject({ kind: "wait" }); // 진행 중 시도가 있으면 새로 부르지 않는다
              expect((await s.runtime()).leaseOwner).toBe("host-b");
            },
          };
    const before = await prisma.conversationScene.count({ where: { worldId: s.world.id } });
    await s.step(a);
    expect(await prisma.conversationScene.count({ where: { worldId: s.world.id } })).toBe(before);
    expect(await prisma.worldEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: "PENDING", claimedAttemptId: null });
    expect(await runWorldTick(s.world.id, a)).toEqual({ kind: "exit" }); // lease를 잃은 Runner는 끝난다
    await s.step(b);
    expect(await prisma.worldEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: "RESOLVED", startedSceneSeq: before + 1 });

    // 여러 탭의 동시 명령: 상태 이벤트는 바뀐 명령마다 1건
    const statusEvents = () => prisma.simulationEvent.count({ where: { worldId: s.world.id, type: "runtime.status" } });
    const n0 = await statusEvents();
    await Promise.all([s.command("pause"), s.command("pause"), s.command("pause")]);
    await Promise.all([s.command("resume"), s.command("resume")]);
    await Promise.all([s.command("stop"), s.command("stop")]);
    expect((await statusEvents()) - n0).toBe(3);
    expect(await s.runtime()).toMatchObject({ status: "IDLE", inFlightAttemptId: null, leaseOwner: null, clockAnchorAt: null });

    await assertInvariants(s);
  });
});

describe("신체 상태 장기 진행", () => {
  it("부상 악화 → 치료 → 자연 회복, 극심 지속 사망, 사망자 발화 제외, 생존자 2명 미만이면 정지하고 재개할 수 없다", async () => {
    const s = await setup("soak-body", 3, 23);
    const runner = s.ctx();
    const [x, y] = s.chars;
    const condition = (id: string) => prisma.characterCondition.findUniqueOrThrow({ where: { characterId: id } });
    const aliasOf = (call: Call, name: string) => [...call.names].find(([, n]) => n === name)?.[0];
    const cond = (character: string, extra: Record<string, unknown>) => ({ character, thermal: null, pain: null, injury: null, treatment: null, death: null, eventRef: null, ...extra });
    /** 대상이 참가자로 뽑힐 때까지 장면을 진행하고, 뽑힌 장면에 제안을 넣는다 */
    const withTarget = async (name: string, proposal: Record<string, unknown>) => {
      let used = false;
      s.plan.next = (call) => {
        const alias = aliasOf(call, name);
        if (!alias || used || call.events.length) return {}; // 사건 장면은 강도 한도가 달라 건너뛴다
        used = true;
        return { conditions: [cond(alias, proposal)] };
      };
      for (let i = 0; i < 30 && !used; i++) await s.step(runner);
      expect(used).toBe(true);
      s.plan.next = () => ({});
    };

    await s.command("start");
    await withTarget(x!.name, { injury: { level: "MODERATE", cause: "낙상" } }); // 한 장면에 한 단계만
    expect(await condition(x!.id)).toMatchObject({ injury: "MILD" });
    await withTarget(x!.name, { injury: { level: "MODERATE", cause: "낙상" } });
    expect(await condition(x!.id)).toMatchObject({ injury: "MODERATE" });
    await withTarget(x!.name, { treatment: "부목을 댔다" });
    expect(await condition(x!.id)).toMatchObject({ injury: "MILD" });
    // 경미한 부상은 월드 24시간 뒤 자연 회복 (실행 중 시간만 센다)
    await s.advance(realMsForWorldSeconds(INJURY_NATURAL_RECOVERY_WORLD_SECONDS.MILD) + 1_000);
    await s.step(runner);
    expect(await condition(x!.id)).toMatchObject({ injury: "NONE" });
    const kinds = (await prisma.characterConditionChange.findMany({ where: { characterId: x!.id } })).map((c) => `${c.kind}:${c.fromValue}>${c.toValue}`);
    expect(kinds.sort()).toEqual(["INJURY:NONE>MILD", "INJURY:MILD>MODERATE", "INJURY:PAIN_NONE>PAIN_MILD", "TREATMENT:MODERATE>MILD", "TREATMENT:PAIN_MILD>PAIN_NONE", "RECOVERY:MILD>NONE"].sort());

    // 극심한 추위: 한 단계씩 극심까지 → 48시간 지속되면 서버가 사망 확정
    for (let i = 0; i < 3; i++) await withTarget(x!.name, { thermal: { cause: "COLD", level: "EXTREME" } });
    expect(await condition(x!.id)).toMatchObject({ thermalLevel: "EXTREME", vital: "ALIVE" });
    await s.advance(realMsForWorldSeconds(EXTREME_LETHAL_WORLD_SECONDS) + 1_000);
    await s.step(runner);
    expect(await condition(x!.id)).toMatchObject({ vital: "DEAD" });
    expect(await s.runtime()).toMatchObject({ status: "RUNNING" }); // 생존자 2명: 계속
    const callsAfterDeath = s.calls.length;
    for (let i = 0; i < 4; i++) await s.step(runner);
    expect(s.calls.slice(callsAfterDeath).every((c) => ![...c.names.values()].includes(x!.name))).toBe(true); // 사망자는 참가·발화하지 않는다

    // 두 번째 인물: 극심 12시간(생명 위험) 뒤 사망 제안 수용 → 생존자 1명 → 이 장면은 저장하고 PAUSED
    for (let i = 0; i < 3; i++) await withTarget(y!.name, { thermal: { cause: "HEAT", level: "EXTREME" } });
    await s.advance(realMsForWorldSeconds(EXTREME_LIFE_RISK_WORLD_SECONDS) + 1_000);
    const scenesBefore = await prisma.conversationScene.count({ where: { worldId: s.world.id } });
    await withTarget(y!.name, { death: { cause: "열사병" } });
    expect(await condition(y!.id)).toMatchObject({ vital: "DEAD", deathCause: "열사병" });
    expect(await prisma.conversationScene.count({ where: { worldId: s.world.id } })).toBe(scenesBefore + 1);
    expect(await s.runtime()).toMatchObject({ status: "PAUSED", statusReason: "NOT_ENOUGH_CHARACTERS", inFlightAttemptId: null, leaseOwner: null, clockAnchorAt: null });
    expect(await runWorldTick(s.world.id, runner)).toEqual({ kind: "exit" });
    await expect(s.command("resume")).rejects.toMatchObject({ code: "NOT_ENOUGH_CHARACTERS" });
    // 사망자도 활성 슬롯을 차지한다
    expect(await prisma.character.count({ where: { worldId: s.world.id, deletedAt: null } })).toBe(3);

    await assertInvariants(s);
  });
});
