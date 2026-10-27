import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/worlds/[worldId]/scenes/route";
import { AUTH_ENV_KEYS, readAuthEnv } from "@/server/auth/env";
import { authOptions } from "@/server/auth/options";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { BadRequestError, NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { ConnectionNotReadyError, GeminiRequestError } from "@/server/domain/providers/gemini-verification";
import { generateScene, SceneValidationFailedError } from "@/server/domain/scenes/generate-scene";
import { createMockGeminiClient, type MockGeminiScript } from "@/server/llm/mock/gemini-mock";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// 대화 장면 생성 (Phase 5-1). 실제 DB + Mock Gemini 클라이언트. 실제 Gemini는 호출하지 않는다.

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "scenes-fingerprint-secret-0123456789",
});

async function setup(label: string, script: MockGeminiScript = {}, opts: { characters?: number; active?: boolean } = {}) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  await saveGeminiApiKey(uid, fakeGeminiKey(label), material);
  if (opts.active !== false) {
    await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
  }
  const world = await createTestWorld(user.id, `${label} 세계`);
  const characters = [];
  for (let i = 0; i < (opts.characters ?? 3); i++) {
    const c = await prisma.character.create({ data: characterData(world.id, `${label}-${i + 1}`) });
    await prisma.emotionState.create({ data: { characterId: c.id, worldId: world.id, mood: "NEUTRAL", intensity: 50 } });
    characters.push(c);
  }
  const mock = createMockGeminiClient(script);
  return { user, uid, world, characters, mock, deps: { client: mock.client, material } };
}

const state = (worldId: string) => prisma.gameState.findUniqueOrThrow({ where: { worldId } });
const logs = (worldId: string) => prisma.apiRequestLog.findMany({ where: { worldId } });

async function expectNothingSaved(worldId: string) {
  expect(await prisma.conversationScene.count({ where: { worldId } })).toBe(0);
  expect(await prisma.message.count({ where: { worldId } })).toBe(0);
  expect(await state(worldId)).toMatchObject({ stateVersion: 0, changeSeq: 0, nextSceneSeq: 1 });
  expect(await prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId } })).toMatchObject({ inFlightAttemptId: null });
}

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("장면 생성 서비스", () => {
  it("2명: Gemini 1회 호출(UsageGuard 기록 1건)로 3턴 장면을 저장하고 상태 버전·자동저장 메타를 갱신한다", async () => {
    const { uid, world, characters, mock, deps } = await setup("scene-ok");
    const [a, b] = characters;
    const scene = await generateScene(uid, world.id, [a!.id, b!.id], deps);

    expect(scene.messages.map((m) => [m.speakerCharacterId, m.speakerName])).toEqual([
      [a!.id, a!.name],
      [b!.id, b!.name],
      [a!.id, a!.name],
    ]);
    expect(scene).toMatchObject({ seq: 1, title: "모의 장면" });
    expect(await state(world.id)).toMatchObject({ stateVersion: 1, changeSeq: 1, nextSceneSeq: 2 });
    expect(await prisma.saveGame.findUniqueOrThrow({ where: { autoForWorldId: world.id } })).toMatchObject({ sceneCount: 1, stateVersionAtSave: 1, snapshotId: null });
    expect(await prisma.sceneParticipant.count({ where: { sceneId: scene.id } })).toBe(2);

    // 외부 호출은 모두 UsageGuard 예약·정산을 거친다: 호출 수 = 호출 기록 수
    expect(mock.calls).toHaveLength(1);
    const recorded = await logs(world.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ outcome: "SUCCESS", callIndex: 0, model: "gemini-mock-flash" });
    // 감정은 바꾸지 않는다
    expect(await prisma.emotionState.findUniqueOrThrow({ where: { characterId: a!.id } })).toMatchObject({ mood: "NEUTRAL", intensity: 50 });
    expect((await prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId: world.id } })).inFlightAttemptId).toBeNull();
  });

  it("3명 장면도 생성하고, 이어지는 장면은 seq가 증가한다", async () => {
    const { uid, world, characters, deps } = await setup("scene-three");
    await generateScene(uid, world.id, characters.map((c) => c.id), deps);
    const second = await generateScene(uid, world.id, characters.map((c) => c.id), deps);
    expect(second.seq).toBe(2);
    expect(await prisma.sceneParticipant.count({ where: { sceneId: second.id } })).toBe(3);
  });

  it("삭제된 캐릭터·다른 세계관 캐릭터는 거부하고 Gemini를 호출하지 않는다", async () => {
    const { uid, world, characters, mock, deps } = await setup("scene-deleted");
    const other = await setup("scene-deleted-other");
    await prisma.character.update({ where: { id: characters[1]!.id }, data: { deletedAt: new Date() } });

    await expect(generateScene(uid, world.id, [characters[0]!.id, characters[1]!.id], deps)).rejects.toBeInstanceOf(BadRequestError);
    await expect(generateScene(uid, world.id, [characters[0]!.id, other.characters[0]!.id], deps)).rejects.toBeInstanceOf(BadRequestError);
    // 타인 세계관은 404
    await expect(generateScene(uid, other.world.id, other.characters.slice(0, 2).map((c) => c.id), deps)).rejects.toBeInstanceOf(NotFoundError);
    expect(mock.calls).toHaveLength(0);
    await expectNothingSaved(world.id);
  });

  it("연결이 ACTIVE가 아니면 호출하지 않는다", async () => {
    const { uid, world, characters, mock, deps } = await setup("scene-inactive", {}, { active: false });
    await expect(generateScene(uid, world.id, [characters[0]!.id, characters[1]!.id], deps)).rejects.toBeInstanceOf(ConnectionNotReadyError);
    expect(mock.calls).toHaveLength(0);
  });

  it.each([
    ["JSON이 아님", "장면입니다"],
    ["턴 수 부족", JSON.stringify({ scene: { title: "t", summary: "s", endReason: "RESOLVED" }, turns: [{ speaker: "C1", dialogue: "a", actionIntent: null, emotionCue: null }, { speaker: "C2", dialogue: "b", actionIntent: null, emotionCue: null }] })],
    [
      "참가하지 않은 별칭",
      JSON.stringify({
        scene: { title: "t", summary: "s", endReason: "RESOLVED" },
        turns: ["C1", "C2", "C3"].map((speaker) => ({ speaker, dialogue: "x", actionIntent: null, emotionCue: null })),
      }),
    ],
  ])("잘못된 응답(%s)은 저장하지 않고 호출 기록을 VALIDATION_ERROR로 남긴다", async (_label, generateText) => {
    const { uid, world, characters, deps } = await setup("scene-invalid", { generateText });
    await expect(generateScene(uid, world.id, [characters[0]!.id, characters[1]!.id], deps)).rejects.toBeInstanceOf(SceneValidationFailedError);
    await expectNothingSaved(world.id);
    const recorded = await logs(world.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.outcome).toBe("VALIDATION_ERROR");
  });

  it("Gemini 오류는 안전한 오류로 바꾸고 저장하지 않으며 재시도하지 않는다", async () => {
    const { uid, world, characters, mock, deps } = await setup("scene-upstream", { failGenerate: "UPSTREAM_ERROR" });
    const error = await generateScene(uid, world.id, [characters[0]!.id, characters[1]!.id], deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiRequestError);
    expect(error).toMatchObject({ status: 502, code: "GEMINI_UPSTREAM_ERROR" });
    expect(mock.calls).toHaveLength(1);
    await expectNothingSaved(world.id);
    expect((await logs(world.id))[0]!.outcome).toBe("HTTP_ERROR");
  });

  it("같은 세계관에서 동시에 두 번 누르면 하나만 Gemini를 호출한다", async () => {
    const { uid, world, characters, mock, deps } = await setup("scene-double", { delayMs: 200 });
    const ids = [characters[0]!.id, characters[1]!.id];
    const results = await Promise.allSettled([generateScene(uid, world.id, ids, deps), generateScene(uid, world.id, ids, deps)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r): r is PromiseRejectedResult => r.status === "rejected")!.reason).toMatchObject({ status: 409, code: "SCENE_IN_PROGRESS" });
    expect(mock.calls).toHaveLength(1);
  });
});

describe("POST /api/worlds/[worldId]/scenes", () => {
  const BASE_URL = "http://localhost:3000";
  const ENV = {
    BETTER_AUTH_SECRET: "scenes-route-test-secret-0123456789abcdef",
    BETTER_AUTH_URL: BASE_URL,
    GOOGLE_CLIENT_ID: "scenes-route-test.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "scenes-route-test-client-secret",
  };
  const saved: Record<string, string | undefined> = {};
  const testAuth = betterAuth({ ...authOptions(readAuthEnv(ENV), prisma), plugins: [testUtils()] });

  beforeAll(() => {
    for (const k of AUTH_ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    delete (globalThis as { __auth?: unknown }).__auth;
  });
  afterAll(() => {
    for (const k of AUTH_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete (globalThis as { __auth?: unknown }).__auth;
  });

  const call = async (worldId: string, body: unknown, userId?: string) => {
    const headers = new Headers({ "content-type": "application/json", origin: BASE_URL });
    if (userId) headers.set("cookie", (await (await testAuth.$context).test.login({ userId })).headers.get("cookie")!);
    const res = await POST(new Request(`${BASE_URL}/api/worlds/${worldId}/scenes`, { method: "POST", headers, body: JSON.stringify(body) }), {
      params: Promise.resolve({ worldId }),
    });
    return { status: res.status, body: await res.json() };
  };

  it("비로그인 401, 타인 세계관 404, 참가자 수 오류·삭제된 캐릭터 400 (모두 외부 호출 전)", async () => {
    const owner = await setup("scene-route-owner");
    const intruder = await createTestUser("scene-route-intruder");
    const ids = owner.characters.slice(0, 2).map((c) => c.id);

    expect((await call(owner.world.id, { characterIds: ids })).status).toBe(401);
    expect((await call(owner.world.id, { characterIds: ids }, intruder.id)).status).toBe(404);
    expect((await call(owner.world.id, { characterIds: [ids[0]] }, owner.user.id)).status).toBe(400);
    expect((await call(owner.world.id, { characterIds: [...owner.characters.map((c) => c.id), "x"] }, owner.user.id)).status).toBe(400);

    await prisma.character.update({ where: { id: ids[1]! }, data: { deletedAt: new Date() } });
    const deleted = await call(owner.world.id, { characterIds: ids }, owner.user.id);
    expect(deleted.status).toBe(400);
    expect(await logs(owner.world.id)).toHaveLength(0);
  });
});
