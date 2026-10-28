import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { getCharacterInsights } from "@/server/domain/characters/insights";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { generateScene, prepareScene, runSceneAttempt, SceneValidationFailedError } from "@/server/domain/scenes/generate-scene";
import { runSimulationCommand } from "@/server/domain/simulation/control";
import { runWorldTick } from "@/server/engine/runner/world-tick";
import type { GeminiKeyClient } from "@/server/llm/gemini/client";
import { createMockGeminiClient, type MockGeminiScript } from "@/server/llm/mock/gemini-mock";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// 감정·관계·기억 반영 (Phase 5-5). 실제 DB + Mock Gemini. 장면 커밋과 같은 트랜잭션, clamp, 참조 검증, 펜싱, 다음 장면 컨텍스트.

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "scene-state-fingerprint-secret-0123456789",
});

const turns = [
  { speaker: "C1", dialogue: "등대에 같이 가 줄래?", actionIntent: null, emotionCue: null },
  { speaker: "C2", dialogue: "좋아, 내일 가자.", actionIntent: null, emotionCue: null },
  { speaker: "C1", dialogue: "약속이야.", actionIntent: null, emotionCue: null },
];
const sceneJson = (proposals: unknown) => JSON.stringify({ scene: { title: "약속", summary: "등대에 가기로 했다.", endReason: "RESOLVED" }, turns, proposals });
const PROPOSALS = {
  emotions: [{ character: "C1", mood: "HAPPY", intensityDelta: 50 }],
  relationships: [{ from: "C1", to: "C2", affinity: 9, trust: 2, respect: 0, familiarity: 3, reason: "약속을 받아 줌" }],
  memories: [
    { owner: "C1", about: "C2", kind: "PROMISE", acquisition: "WITNESSED", content: "나래와 내일 등대에 가기로 약속했다", importance: 9 },
    { owner: "C2", about: null, kind: "EVENT", acquisition: "WITNESSED", content: "가람의 부탁을 들어주었다", importance: 2 },
  ],
};

async function setup(label: string, script: MockGeminiScript = { generateText: sceneJson(PROPOSALS) }) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  await saveGeminiApiKey(uid, fakeGeminiKey(label), material);
  await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
  const world = await createTestWorld(user.id, `${label} 세계`);
  const chars = [];
  for (const name of ["가람", "나래", "다온"]) {
    const c = await prisma.character.create({ data: characterData(world.id, name) });
    await prisma.emotionState.create({ data: { characterId: c.id, worldId: world.id, mood: "NEUTRAL", intensity: 50 } });
    chars.push(c);
  }
  const mock = createMockGeminiClient(script);
  // 프롬프트 확인용으로 요청을 기록하는 클라이언트 (테스트 전용)
  const prompts: string[] = [];
  const client: GeminiKeyClient = { ...mock.client, generateJson: (key, req, meter) => (prompts.push(req.prompt), mock.client.generateJson(key, req, meter)) };
  // random 0 → 활성 순서대로 2명(가람=C1, 나래=C2), 다온은 비참가자
  return { user, uid, world, chars, mock, prompts, deps: { client, material, random: () => 0 } };
}

const counts = async (worldId: string) => ({
  scenes: await prisma.conversationScene.count({ where: { worldId } }),
  emotionChanges: await prisma.emotionChange.count({ where: { worldId } }),
  relationshipChanges: await prisma.relationshipChange.count({ where: { worldId } }),
  memories: await prisma.characterMemory.count({ where: { worldId } }),
});

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("감정·관계·기억 반영", () => {
  it("장면과 함께 clamp된 감정(±20)·관계(±5)와 참가자의 기억을 저장하고, 비참가자는 바뀌지 않는다", async () => {
    const { uid, world, chars, deps } = await setup("state-apply");
    const [garam, narae, daon] = chars;
    const scene = await generateScene(uid, world.id, deps);

    expect(await prisma.emotionState.findUniqueOrThrow({ where: { characterId: garam!.id } })).toMatchObject({ mood: "HAPPY", intensity: 70 });
    expect(await prisma.emotionChange.findFirstOrThrow({ where: { characterId: garam!.id } })).toMatchObject({ sceneId: scene.id, dIntensity: 20, proposedDelta: 50, clamped: true });
    expect(await prisma.relationshipState.findUniqueOrThrow({ where: { fromCharacterId_toCharacterId: { fromCharacterId: garam!.id, toCharacterId: narae!.id } } })).toMatchObject({
      affinity: 5,
      trust: 2,
      familiarity: 3,
    });
    expect(await prisma.relationshipChange.findFirstOrThrow({ where: { worldId: world.id } })).toMatchObject({ sceneId: scene.id, dAffinity: 5, clamped: true });

    const memories = await prisma.characterMemory.findMany({ where: { worldId: world.id }, orderBy: { importance: "desc" } });
    expect(memories.map((m) => [m.ownerCharacterId, m.aboutCharacterId, m.importance, m.sourceSceneId])).toEqual([
      [garam!.id, narae!.id, 5, scene.id], // 중요도 9 → 5
      [narae!.id, null, 2, scene.id],
    ]);
    // 비참가자: 기억·감정·관계 변화 없음
    expect(await prisma.characterMemory.count({ where: { ownerCharacterId: daon!.id } })).toBe(0);
    expect(await prisma.emotionState.findUniqueOrThrow({ where: { characterId: daon!.id } })).toMatchObject({ mood: "NEUTRAL", intensity: 50 });

    // 상세 화면 조회: 현재 관계와 이 캐릭터의 기억만
    const insights = await getCharacterInsights(uid, world.id, garam!.id);
    expect(insights.relations.find((r) => r.otherId === narae!.id)).toMatchObject({ outgoing: { affinity: 5 }, incoming: { affinity: 0 } });
    expect(insights.memories.map((m) => m.content)).toEqual(["나래와 내일 등대에 가기로 약속했다"]);
  });

  it("다음 장면 프롬프트에 바뀐 감정·관계와 소유자 라벨이 붙은 기억이 들어간다", async () => {
    const { uid, world, prompts, deps } = await setup("state-next");
    await generateScene(uid, world.id, deps);
    await generateScene(uid, world.id, deps);
    const second = prompts[1]!;
    expect(second).toContain("현재 감정: HAPPY (강도 70/100)");
    expect(second).toContain("- C2 나래: 호감 5, 신뢰 2, 존중 0, 친밀 3");
    const c1Block = second.slice(second.indexOf('<character alias="C1">'), second.indexOf('<character alias="C2">'));
    const c2Block = second.slice(second.indexOf('<character alias="C2">'));
    expect(c1Block).toContain("[C1만 아는 기억]");
    expect(c1Block).toContain("나래와 내일 등대에 가기로 약속했다");
    expect(c2Block).not.toContain("나래와 내일 등대에 가기로 약속했다"); // 다른 인물의 기억은 섞이지 않는다
    expect(second).not.toContain("다온");
  });

  it("참가자가 아닌 별칭을 참조하면 장면 실패이고 아무것도 저장하지 않는다", async () => {
    const proposals = { ...PROPOSALS, memories: [{ ...PROPOSALS.memories[0], owner: "C3" }] };
    const { uid, world, deps } = await setup("state-badref", { generateText: sceneJson(proposals) });
    await expect(generateScene(uid, world.id, deps)).rejects.toBeInstanceOf(SceneValidationFailedError);
    expect(await counts(world.id)).toEqual({ scenes: 0, emotionChanges: 0, relationshipChanges: 0, memories: 0 });
  });

  it("같은 시도(attemptId)의 결과가 다시 도착해도 상태 변화는 한 번만 반영된다", async () => {
    const { uid, world, deps } = await setup("state-dup");
    const prepared = await prepareScene(uid, world.id, deps);
    // 수동 시도는 점유한 시도만 커밋된다 (generateScene의 점유를 흉내 낸다)
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { inFlightAttemptId: "dup-attempt", inFlightStartedAt: new Date() } });
    await runSceneAttempt(uid, world.id, prepared, { attemptId: "dup-attempt" }, deps);
    const after = await counts(world.id);
    await expect(runSceneAttempt(uid, world.id, prepared, { attemptId: "dup-attempt" }, deps)).rejects.toThrow();
    expect(await counts(world.id)).toEqual(after);
    expect(after).toEqual({ scenes: 1, emotionChanges: 1, relationshipChanges: 1, memories: 2 });
  });

  it("Runner 시도 중 stop → 오래된 결과의 장면·감정·관계·기억을 모두 버린다", async () => {
    const { uid, user, world, mock, deps } = await setup("state-stop", { generateText: sceneJson(PROPOSALS), delayMs: 300 });
    await runSimulationCommand(uid, world.id, "start");
    await prisma.sseConnection.create({ data: { worldId: world.id, userId: user.id, instanceId: "test", lastSeenAt: new Date("2100-01-01T00:00:00Z") } });
    const tick = runWorldTick(world.id, { owner: "host-a", deps, state: { failures: 0 } });
    while (mock.receivedKeys.length === 0) await new Promise((r) => setTimeout(r, 10));
    await runSimulationCommand(uid, world.id, "stop");
    await tick;
    expect(mock.calls).toHaveLength(1);
    expect(await counts(world.id)).toEqual({ scenes: 0, emotionChanges: 0, relationshipChanges: 0, memories: 0 });
  });
});
