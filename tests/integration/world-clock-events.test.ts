import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { EXTREME_LETHAL_WORLD_SECONDS } from "../../config/limits";
import type { CharacterInput } from "@/lib/schemas/character";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { updateCharacter } from "@/server/domain/characters/characters";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { generateScene, prepareScene } from "@/server/domain/scenes/generate-scene";
import { reconcileClientHold } from "@/server/domain/simulation/client-hold";
import { runSimulationCommand } from "@/server/domain/simulation/control";
import { touchWorldClock } from "@/server/domain/simulation/world-clock";
import { runWorldTick } from "@/server/engine/runner/world-tick";
import type { GeminiKeyClient } from "@/server/llm/gemini/client";
import { createMockGeminiClient } from "@/server/llm/mock/gemini-mock";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// Phase 7-2-2: 월드 시계(RUNNING 동안만 ×36, 일시정지·보류·크래시 구간 제외, 장면 커밋에 기록), 자동 사건 발생·진행·해결(한 번만),
// 신체 상태·사망(극심 지속 확정, 근거 없는 사망 제안 무시, 사망자 참가 제외, 생존자 2명 미만이면 정지), 펜싱 실패 시 무변경. 실제 DB + Mock Gemini.

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "world-clock-fingerprint-0123456789",
});
const T0 = Date.parse("2026-10-28T03:00:00.000Z");

const turns = [
  { speaker: "C1", dialogue: "가", actionIntent: null, emotionCue: null },
  { speaker: "C2", dialogue: "나", actionIntent: null, emotionCue: null },
  { speaker: "C1", dialogue: "다", actionIntent: null, emotionCue: null },
];
const sceneJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ scene: { title: "t", summary: "s", endReason: "RESOLVED" }, turns, proposals: { emotions: [], relationships: [], memories: [] }, ...extra });

async function setup(label: string, characters = 2) {
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
  await prisma.sseConnection.create({ data: { worldId: world.id, userId: user.id, instanceId: "test", lastSeenAt: new Date("2100-01-01T00:00:00.000Z") } });
  const clock = { ms: T0 };
  const prompts: string[] = [];
  const clientFor = (text?: string): GeminiKeyClient => {
    const mock = createMockGeminiClient(text ? { generateText: text } : {});
    return {
      ...mock.client,
      generateJson: (apiKey, request, meter) => {
        prompts.push(request.prompt);
        return mock.client.generateJson(apiKey, request, meter);
      },
    };
  };
  const deps = (text?: string) => ({ client: clientFor(text), material, now: () => new Date(clock.ms), random: () => 0 });
  const at = (s: number) => new Date(T0 + s * 1000);
  const worldSeconds = async () => (await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } })).worldSeconds;
  return { user, uid, world, chars, clock, deps, prompts, at, worldSeconds };
}

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("월드 시계", () => {
  it("RUNNING 동안만 실제 시간 × 36으로 흐르고, 일시정지 시간은 세지 않으며, 빠른 일시정지·재개에도 두 번 세지 않는다", async () => {
    const { uid, world, at, worldSeconds } = await setup("clock-basic");
    await runSimulationCommand(uid, world.id, "start", () => at(0));
    await touchWorldClock(world.id, at(20));
    await runSimulationCommand(uid, world.id, "pause", () => at(40)); // 40초 × 36
    expect(await worldSeconds()).toBe(40 * 36);
    await runSimulationCommand(uid, world.id, "pause", () => at(41)); // noop: 다시 정산하지 않는다
    await runSimulationCommand(uid, world.id, "resume", () => at(1000)); // 일시정지 960초는 세지 않는다
    await runSimulationCommand(uid, world.id, "pause", () => at(1010));
    expect(await worldSeconds()).toBe(50 * 36);
    expect((await prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId: world.id } })).clockAnchorAt).toBeNull();
    await runSimulationCommand(uid, world.id, "stop", () => at(5000));
    expect(await worldSeconds()).toBe(50 * 36);
  });

  it("크래시(확인 끊김 30초 초과) 구간은 마지막 확인까지만 세고, 연결 보류 동안 멈췄다가 연결되면 다시 흐른다", async () => {
    const { uid, world, at, worldSeconds } = await setup("clock-gap");
    await runSimulationCommand(uid, world.id, "start", () => at(0));
    await touchWorldClock(world.id, at(20));
    await touchWorldClock(world.id, at(500)); // 20초 뒤 확인이 끊겼다가 500초에 재기동 → 20초까지만 정산, 기준은 500초
    expect(await worldSeconds()).toBe(20 * 36);
    await prisma.sseConnection.deleteMany({ where: { worldId: world.id } });
    expect(await reconcileClientHold(world.id, at(510))).toBe("held"); // 보류: 510초까지 정산하고 멈춤
    expect(await worldSeconds()).toBe(30 * 36);
    await prisma.sseConnection.create({ data: { worldId: world.id, userId: (await prisma.world.findUniqueOrThrow({ where: { id: world.id } })).ownerId, instanceId: "t", lastSeenAt: new Date("2100-01-01T00:00:00Z") } });
    expect(await reconcileClientHold(world.id, at(560))).toBe("connected"); // 보류 50초는 세지 않는다
    await runSimulationCommand(uid, world.id, "pause", () => at(570));
    expect(await worldSeconds()).toBe(40 * 36);
  });

  it("장면 커밋이 그 시점의 월드 시각을 기록하고(호출 중 경과 포함), 다음 장면 프롬프트에 Day N, HH:MM이 들어간다", async () => {
    const { uid, world, clock, deps, prompts } = await setup("clock-scene");
    const d = deps();
    await runSimulationCommand(uid, world.id, "start", d.now);
    clock.ms += 10_000;
    await runWorldTick(world.id, { owner: "host-a", deps: d, state: { failures: 0 } });
    const scene = await prisma.conversationScene.findFirstOrThrow({ where: { worldId: world.id } });
    expect(scene.worldSeconds).toBe(360);
    clock.ms += 20_000;
    await runWorldTick(world.id, { owner: "host-a", deps: d, state: { failures: 0 } });
    expect(prompts.at(-1)).toContain("현재 월드 시각: Day 0, 00:");
  });
});

describe("자동 사건", () => {
  it("예약 장면에서 한 번만 발생하고(발생 완료로 기록), 실패한 시도는 사건을 남기지 않으며, 이후 장면에 다시 주입하지 않는다", async () => {
    const { uid, world, chars, deps, prompts } = await setup("auto-event");
    await prisma.gameState.update({ where: { worldId: world.id }, data: { nextSceneSeq: 3 } });
    await prisma.worldEventPeriod.create({ data: { worldId: world.id, periodIndex: 0, won: true, scheduledSceneSeq: 3 } });

    // 1) 응답 검증 실패 → 사건·발생 기록·기억 없음 (프리셋은 구간에 고정되어 재시도에도 같다)
    await expect(generateScene(uid, world.id, deps("not json"))).rejects.toMatchObject({ code: "SCENE_VALIDATION_FAILED" });
    expect(await prisma.worldEvent.count({ where: { worldId: world.id } })).toBe(0);
    expect(await prisma.characterMemory.count({ where: { worldId: world.id } })).toBe(0);
    const period = await prisma.worldEventPeriod.findUniqueOrThrow({ where: { worldId_periodIndex: { worldId: world.id, periodIndex: 0 } } });
    expect(period).toMatchObject({ firedAt: null, eventId: null });
    expect(period.presetId).not.toBeNull();
    expect(prompts.at(-1)).toContain("<events>");

    // 2) 다시 시도 → 사건 발생 완료 (결과 필드가 없어도 기록), 참가자에게 사실 기억 보완
    const view = await generateScene(uid, world.id, deps(sceneJson()));
    const event = await prisma.worldEvent.findFirstOrThrow({ where: { worldId: world.id } });
    expect(event).toMatchObject({ kind: "RANDOM", status: "RESOLVED", presetId: period.presetId, startedSceneSeq: 3, resolvedSceneSeq: 3, resolutionSummary: null, startedWorldSeconds: 0 });
    expect((await prisma.worldEventPeriod.findFirstOrThrow({ where: { worldId: world.id } })).eventId).toBe(event.id);
    expect(view.notes.filter((n) => n.kind.startsWith("EVENT"))).toEqual([expect.objectContaining({ kind: "EVENT_STARTED" })]); // 배너 한 번
    const memories = await prisma.characterMemory.findMany({ where: { worldId: world.id } });
    expect(memories.map((m) => m.ownerCharacterId).sort()).toEqual(chars.map((c) => c.id).sort());
    expect(memories.every((m) => m.kind === "EVENT" && m.acquisition === "WITNESSED" && m.shareGroupId === event.id)).toBe(true);

    // 3) 다음 장면: 같은 구간에서 다시 발생하지 않고, 사건을 프롬프트에 다시 넣지 않는다
    await generateScene(uid, world.id, deps(sceneJson()));
    expect(prompts.at(-1)).not.toContain("<events>");
    expect(await prisma.worldEvent.count({ where: { worldId: world.id } })).toBe(1);
    expect(await prisma.characterMemory.count({ where: { worldId: world.id } })).toBe(2);
    const scenes = await prisma.conversationScene.findMany({ where: { worldId: world.id }, orderBy: { seq: "asc" } });
    expect(scenes.map((s) => s.motiveType)).toEqual(["WORLD_EVENT", "MIXED"]);
  });
});

describe("과거 진행 중(ACTIVE)·해결(RESOLVED) 사건 호환", () => {
  it("기존 기록은 그대로 두고 프롬프트에 다시 넣지 않으며, 장면에서 상태를 바꾸지 않는다", async () => {
    const { uid, world, deps, prompts } = await setup("legacy-events");
    const legacy = await prisma.worldEvent.create({
      data: { worldId: world.id, kind: "RANDOM", status: "ACTIVE", presetId: "discovery_traces", intensity: "LOW", title: "옛 사건", description: "오래된 진행 중 사건", startedSceneSeq: 1, lastSceneSeq: 1 },
    });
    const old = await prisma.worldEvent.create({
      data: { worldId: world.id, kind: "RANDOM", status: "RESOLVED", presetId: "discovery_object", intensity: "LOW", title: "해결된 사건", description: "d", startedSceneSeq: 1, resolvedSceneSeq: 2, resolutionSummary: "끝남" },
    });
    await prisma.gameState.update({ where: { worldId: world.id }, data: { nextSceneSeq: 2 } });
    await generateScene(uid, world.id, deps(sceneJson({ events: [{ ref: "E1", status: "RESOLVED", resolutionSummary: "x", realization: null, usedFallback: false }] })));
    expect(prompts.at(-1)).not.toContain("옛 사건");
    expect(prompts.at(-1)).not.toContain("<events>");
    expect(await prisma.worldEvent.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ status: "ACTIVE", lastSceneSeq: 1 });
    expect(await prisma.worldEvent.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: "RESOLVED", resolutionSummary: "끝남" });
  });
});

describe("신체 상태와 사망", () => {
  it("극심이 48시간 이어지면 다음 커밋에서 사망을 확정하고, 근거 없는 사망 제안은 무시하며, 사망자는 참가자에서 빠진다", async () => {
    const { uid, world, chars, deps } = await setup("death", 3);
    const [a, b] = chars;
    await prisma.gameState.update({ where: { worldId: world.id }, data: { worldSeconds: EXTREME_LETHAL_WORLD_SECONDS } });
    await prisma.characterCondition.update({
      where: { characterId: a!.id },
      data: { thermalCause: "COLD", thermalLevel: "EXTREME", thermalSinceSeconds: 0, extremeSinceSeconds: 0 },
    });
    // 근거 없는 사망 제안(C1·C2)은 무시된다. a는 참가 여부와 관계없이 극심 지속으로 사망
    const death = (who: string) => ({ character: who, thermal: null, pain: null, injury: null, treatment: null, death: { cause: "갑자기" }, eventRef: null });
    const view = await generateScene(uid, world.id, deps(sceneJson({ conditions: [death("C1"), death("C2")] })));
    const conditions = await prisma.characterCondition.findMany({ where: { worldId: world.id } });
    expect(conditions.filter((c) => c.vital === "DEAD").map((c) => c.characterId)).toEqual([a!.id]);
    expect(conditions.find((c) => c.characterId === a!.id)).toMatchObject({ deathCause: "극심한 추위가 오래 이어짐", deathWorldSeconds: EXTREME_LETHAL_WORLD_SECONDS });
    expect(view.notes).toContainEqual(expect.objectContaining({ kind: "DEATH" }));

    // 사망자는 참가자 후보에서 빠지고, 수정할 수 없다. 슬롯은 그대로 차지한다
    for (let i = 0; i < 5; i++) expect((await prepareScene(uid, world.id, deps())).characterIds).not.toContain(a!.id);
    await expect(updateCharacter(uid, world.id, a!.id, { name: "x", gender: "MALE", age: 30, personalityTags: ["calm", "honest", "diligent"], goal: "", characterContext: "", childhoodBackgroundId: "childhood_farm", adulthoodBackgroundId: "adulthood_farmer" } satisfies CharacterInput)).rejects.toMatchObject({ code: "CHARACTER_DEAD" });
    expect(await prisma.character.count({ where: { worldId: world.id, deletedAt: null } })).toBe(3);
    expect(b).toBeDefined();
  });

  it("실행 중 사망으로 생존자가 2명 미만이 되면 이 장면은 커밋하고 PAUSED(NOT_ENOUGH_CHARACTERS)가 되며, 재개할 수 없다", async () => {
    const { uid, world, chars, clock, deps } = await setup("death-stop", 2);
    await prisma.gameState.update({ where: { worldId: world.id }, data: { worldSeconds: EXTREME_LETHAL_WORLD_SECONDS } });
    await prisma.characterCondition.update({ where: { characterId: chars[0]!.id }, data: { injury: "CRITICAL", injuryCause: "추락", injuryUpdatedAtSeconds: 0, extremeSinceSeconds: 0 } });
    const d = deps();
    await runSimulationCommand(uid, world.id, "start", d.now);
    clock.ms += 1000;
    await runWorldTick(world.id, { owner: "host-a", deps: d, state: { failures: 0 } });
    expect(await prisma.conversationScene.count({ where: { worldId: world.id } })).toBe(1);
    expect(await prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId: world.id } })).toMatchObject({ status: "PAUSED", statusReason: "NOT_ENOUGH_CHARACTERS", inFlightAttemptId: null, clockAnchorAt: null });
    await expect(runSimulationCommand(uid, world.id, "resume", d.now)).rejects.toMatchObject({ code: "NOT_ENOUGH_CHARACTERS" });
  });

  it("펜싱 실패(호출 중 설정 변경)면 예약된 자동 사건·사망·상태 변화가 하나도 남지 않는다", async () => {
    const { uid, world, chars, deps } = await setup("fence-world", 3);
    await prisma.gameState.update({ where: { worldId: world.id }, data: { nextSceneSeq: 3, worldSeconds: EXTREME_LETHAL_WORLD_SECONDS } });
    await prisma.worldEventPeriod.create({ data: { worldId: world.id, periodIndex: 0, won: true, scheduledSceneSeq: 3 } });
    await prisma.characterCondition.update({ where: { characterId: chars[0]!.id }, data: { thermalCause: "HEAT", thermalLevel: "EXTREME", thermalSinceSeconds: 0, extremeSinceSeconds: 0 } });
    const d = deps(sceneJson());
    const editing: GeminiKeyClient = {
      ...d.client,
      generateJson: async (apiKey, request, meter) => {
        await prisma.$executeRaw`UPDATE "GameState" SET "settingsSeq" = "settingsSeq" + 1 WHERE "worldId" = ${world.id}`;
        return d.client.generateJson(apiKey, request, meter);
      },
    };
    await expect(generateScene(uid, world.id, { ...d, client: editing })).rejects.toMatchObject({ code: "SETTINGS_CHANGED" });
    expect(await prisma.worldEvent.count({ where: { worldId: world.id } })).toBe(0);
    expect(await prisma.characterCondition.findUniqueOrThrow({ where: { characterId: chars[0]!.id } })).toMatchObject({ vital: "ALIVE" });
    expect(await prisma.characterConditionChange.count({ where: { worldId: world.id } })).toBe(0);
    expect(await prisma.worldEventPeriod.findFirstOrThrow({ where: { worldId: world.id } })).toMatchObject({ firedAt: null });
  });
});
