import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_ACTIVE_CHARACTERS_PER_WORLD } from "../../config/limits";
import { bigFiveFromTags } from "../../config/personality-map";
import { DELETE, GET as GET_ONE, PATCH } from "@/app/api/worlds/[worldId]/characters/[characterId]/route";
import { POST as RANDOM } from "@/app/api/worlds/[worldId]/characters/random/route";
import { GET as LIST, POST } from "@/app/api/worlds/[worldId]/characters/route";
import { AUTH_ENV_KEYS, readAuthEnv } from "@/server/auth/env";
import { authOptions } from "@/server/auth/options";
import { prisma } from "@/server/db/client";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld } from "./helpers";

// 캐릭터 Route Handler를 실제 Better Auth 세션 쿠키로 호출한다 (Phase 4-2, PRD FR-04, database.md §6.6·§7).

const BASE_URL = "http://localhost:3000";
const ENV = {
  BETTER_AUTH_SECRET: "characters-route-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: BASE_URL,
  GOOGLE_CLIENT_ID: "characters-route-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "characters-route-test-client-secret",
};
const saved: Record<string, string | undefined> = {};
const testAuth = betterAuth({ ...authOptions(readAuthEnv(ENV), prisma), plugins: [testUtils()] });

beforeAll(() => {
  for (const k of AUTH_ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  delete (globalThis as { __auth?: unknown }).__auth;
});

afterAll(async () => {
  for (const k of AUTH_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete (globalThis as { __auth?: unknown }).__auth;
  await cleanupTestUsers();
  await prisma.$disconnect();
});

async function loginCookie(userId: string): Promise<string> {
  const { headers } = await (await testAuth.$context).test.login({ userId });
  return headers.get("cookie")!;
}

function req(method: string, init: { cookie?: string; body?: unknown } = {}) {
  const headers = new Headers({ "content-type": "application/json", origin: BASE_URL });
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${BASE_URL}/api/worlds/x/characters`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

const worldCtx = (worldId: string) => ({ params: Promise.resolve({ worldId }) });
const charCtx = (worldId: string, characterId: string) => ({ params: Promise.resolve({ worldId, characterId }) });

async function json(res: Response) {
  return { status: res.status, body: await res.json() };
}

const valid = (name = "도윤") => ({
  name,
  gender: "MALE",
  age: 27,
  personalityTags: ["sociable", "calm", "diligent"],
  goal: "동료를 찾는다",
  characterContext: "차분한 말투",
  childhoodBackgroundId: "childhood_city",
  adulthoodBackgroundId: "adulthood_doctor",
});

async function setup(label: string) {
  const user = await createTestUser(label);
  const world = await createTestWorld(user.id);
  return { user, world, cookie: await loginCookie(user.id) };
}

const changeSeq = async (worldId: string) => (await prisma.gameState.findUniqueOrThrow({ where: { worldId } })).changeSeq;

describe("캐릭터 CRUD", () => {
  it("비로그인 요청은 401", async () => {
    expect((await LIST(req("GET"), worldCtx("w"))).status).toBe(401);
    expect((await POST(req("POST", { body: valid() }), worldCtx("w"))).status).toBe(401);
    expect((await GET_ONE(req("GET"), charCtx("w", "c"))).status).toBe(401);
    expect((await RANDOM(req("POST", { body: {} }), worldCtx("w"))).status).toBe(401);
  });

  it("생성: Big Five는 태그에서 계산하고 EmotionState를 초기화하며 changeSeq를 올린다. 성별은 남자·여자만, 빈 나이는 자동(19~80)", async () => {
    const { world, cookie } = await setup("char-create");
    const r = await json(await POST(req("POST", { cookie, body: { ...valid(), extraversion: 99, worldId: "other" } }), worldCtx(world.id)));
    expect(r.status).toBe(201);
    expect(r.body.character).toMatchObject({ name: "도윤", gender: "MALE", age: 27, bigFive: bigFiveFromTags(["sociable", "calm", "diligent"]) });
    expect(r.body.character.emotion).toEqual({ mood: "NEUTRAL", intensity: 50 });
    expect(await changeSeq(world.id)).toBe(1);

    for (const gender of ["AUTO", "NONBINARY", "CUSTOM", "UNSPECIFIED", null]) {
      expect((await POST(req("POST", { cookie, body: { ...valid("거절"), gender } }), worldCtx(world.id))).status).toBe(400);
    }
    const auto = await json(await POST(req("POST", { cookie, body: { ...valid("자동"), gender: "FEMALE", age: null } }), worldCtx(world.id)));
    expect(auto.body.character.gender).toBe("FEMALE");
    expect(auto.body.character.age).toBeGreaterThanOrEqual(19);
    expect(auto.body.character.age).toBeLessThanOrEqual(80);

    const list = await json(await LIST(req("GET", { cookie }), worldCtx(world.id)));
    expect(list.body.characters.map((c: { name: string }) => c.name)).toEqual(["도윤", "자동"]);
  });

  it("컨텍스트는 코드 포인트 300자까지 허용, 301자는 400. 성격 태그는 3~5개", async () => {
    const { world, cookie } = await setup("char-context");
    const ok = await POST(req("POST", { cookie, body: { ...valid(), characterContext: "😀".repeat(300) } }), worldCtx(world.id));
    expect(ok.status).toBe(201);
    const tooLong = await json(await POST(req("POST", { cookie, body: { ...valid(), characterContext: "가".repeat(301) } }), worldCtx(world.id)));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.message).toContain("300자");
    const fewTags = await POST(req("POST", { cookie, body: { ...valid(), personalityTags: ["calm", "kind"] } }), worldCtx(world.id));
    expect(fewTags.status).toBe(400);
    expect(await prisma.character.count({ where: { worldId: world.id } })).toBe(1);
  });

  it("타인 세계관·캐릭터는 조회·생성·수정·삭제·랜덤 모두 404이고 데이터는 그대로다", async () => {
    const owner = await setup("char-owner");
    const intruder = await setup("char-intruder");
    const c = await prisma.character.create({ data: characterData(owner.world.id, "주인공") });
    const cookie = intruder.cookie;

    expect((await LIST(req("GET", { cookie }), worldCtx(owner.world.id))).status).toBe(404);
    expect((await POST(req("POST", { cookie, body: valid() }), worldCtx(owner.world.id))).status).toBe(404);
    expect((await RANDOM(req("POST", { cookie, body: {} }), worldCtx(owner.world.id))).status).toBe(404);
    expect((await GET_ONE(req("GET", { cookie }), charCtx(owner.world.id, c.id))).status).toBe(404);
    expect((await PATCH(req("PATCH", { cookie, body: valid("탈취") }), charCtx(owner.world.id, c.id))).status).toBe(404);
    expect((await DELETE(req("DELETE", { cookie }), charCtx(owner.world.id, c.id))).status).toBe(404);
    // 자기 세계관 ID에 타인 캐릭터 ID를 붙여도 404
    expect((await GET_ONE(req("GET", { cookie }), charCtx(intruder.world.id, c.id))).status).toBe(404);
    expect((await DELETE(req("DELETE", { cookie }), charCtx(intruder.world.id, c.id))).status).toBe(404);

    const after = await prisma.character.findUniqueOrThrow({ where: { id: c.id } });
    expect(after).toMatchObject({ name: "주인공", deletedAt: null });
    expect(await prisma.character.count({ where: { worldId: owner.world.id } })).toBe(1);
    expect(await changeSeq(owner.world.id)).toBe(0);
  });

  it("활성 6명 상한: 동시에 8건을 보내도 정확히 6명이 되고 나머지는 409", async () => {
    const { world, cookie } = await setup("char-limit");
    for (let i = 0; i < 4; i++) await prisma.character.create({ data: characterData(world.id, `기존${i}`) });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => POST(req("POST", { cookie, body: valid(`동시${i}`) }), worldCtx(world.id)).then((r) => r.status)),
    );
    expect(results.filter((s) => s === 201)).toHaveLength(2);
    expect(results.filter((s) => s === 409)).toHaveLength(6);
    expect(await prisma.character.count({ where: { worldId: world.id, deletedAt: null } })).toBe(MAX_ACTIVE_CHARACTERS_PER_WORLD);
    expect(await prisma.emotionState.count({ where: { worldId: world.id } })).toBe(2);
    expect(await changeSeq(world.id)).toBe(2);
  });

  it("수정: 실제 변경 시에만 changeSeq를 올리고 감정·관계·기억·메시지는 유지한다", async () => {
    const { world, cookie } = await setup("char-update");
    const created = await json(await POST(req("POST", { cookie, body: valid("수정 전") }), worldCtx(world.id)));
    const id: string = created.body.character.id;
    const other = await prisma.character.create({ data: characterData(world.id, "상대") });
    await prisma.relationshipState.create({
      data: { worldId: world.id, fromCharacterId: id, toCharacterId: other.id, affinity: 30, trust: 10, respect: 0, familiarity: 5 },
    });
    const before = await changeSeq(world.id);

    const r = await json(
      await PATCH(req("PATCH", { cookie, body: { ...valid("수정 후"), personalityTags: ["reserved", "sensitive", "curious", "kind"] } }), charCtx(world.id, id)),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: true, character: { name: "수정 후", bigFive: bigFiveFromTags(["reserved", "sensitive", "curious", "kind"]) } });
    expect(await changeSeq(world.id)).toBe(before + 1);

    const same = await json(
      await PATCH(req("PATCH", { cookie, body: { ...valid("수정 후"), personalityTags: ["reserved", "sensitive", "curious", "kind"] } }), charCtx(world.id, id)),
    );
    expect(same.body.changed).toBe(false);
    expect(await changeSeq(world.id)).toBe(before + 1);
    expect(await prisma.relationshipState.count({ where: { fromCharacterId: id } })).toBe(1);
    expect(await prisma.emotionState.count({ where: { characterId: id } })).toBe(1);
  });

  it("소프트 삭제: 목록·상한에서 빠지고 메시지·관계·기억·감정은 보존한다", async () => {
    const { world, cookie } = await setup("char-delete");
    const a = await prisma.character.create({ data: characterData(world.id, "A") });
    const b = await prisma.character.create({ data: characterData(world.id, "B") });
    const scene = await prisma.conversationScene.create({
      data: {
        worldId: world.id,
        seq: 1,
        attemptId: randomUUID(),
        strategyMode: "STORY",
        model: "mock",
        title: "장면",
        summary: "요약",
        motiveType: "GOAL",
        endReason: "RESOLVED",
      },
    });
    await prisma.message.create({
      data: { sceneId: scene.id, worldId: world.id, turnIndex: 0, speakerCharacterId: a.id, speakerNameSnapshot: "A", dialogue: "안녕" },
    });
    await prisma.relationshipState.create({
      data: { worldId: world.id, fromCharacterId: a.id, toCharacterId: b.id, affinity: 0, trust: 0, respect: 0, familiarity: 0 },
    });
    await prisma.characterMemory.create({
      data: { worldId: world.id, ownerCharacterId: a.id, kind: "EVENT", acquisition: "WITNESSED", content: "기억", importance: 3 },
    });
    await prisma.emotionState.create({ data: { characterId: a.id, worldId: world.id, mood: "HAPPY", intensity: 70 } });

    const r = await json(await DELETE(req("DELETE", { cookie }), charCtx(world.id, a.id)));
    expect(r).toEqual({ status: 200, body: { deleted: true } });
    expect(await changeSeq(world.id)).toBe(1);

    expect((await prisma.character.findUniqueOrThrow({ where: { id: a.id } })).deletedAt).not.toBeNull();
    expect(await prisma.message.count({ where: { speakerCharacterId: a.id } })).toBe(1);
    expect(await prisma.relationshipState.count({ where: { fromCharacterId: a.id } })).toBe(1);
    expect(await prisma.characterMemory.count({ where: { ownerCharacterId: a.id } })).toBe(1);
    expect(await prisma.emotionState.count({ where: { characterId: a.id } })).toBe(1);

    const list = await json(await LIST(req("GET", { cookie }), worldCtx(world.id)));
    expect(list.body.characters.map((c: { name: string }) => c.name)).toEqual(["B"]);
    expect((await GET_ONE(req("GET", { cookie }), charCtx(world.id, a.id))).status).toBe(404);
    expect((await DELETE(req("DELETE", { cookie }), charCtx(world.id, a.id))).status).toBe(404);
  });

  it("랜덤: 전체 랜덤·항목별 랜덤 모두 잠긴 필드를 유지하고 DB에는 쓰지 않는다", async () => {
    const { world, cookie } = await setup("char-random");
    const draft = { name: "고정", gender: "FEMALE", age: 300, personalityTags: ["kind"], goal: "", characterContext: "유지" };

    const all = await json(
      await RANDOM(req("POST", { cookie, body: { draft, lockedFields: ["name", "gender", "characterContext"] } }), worldCtx(world.id)),
    );
    expect(all.status).toBe(200);
    expect(all.body.draft).toMatchObject({ name: "고정", gender: "FEMALE", characterContext: "유지" });
    expect(all.body.draft.personalityTags.length).toBeGreaterThanOrEqual(3);
    expect(all.body.draft.goal).not.toBe("");

    const one = await json(await RANDOM(req("POST", { cookie, body: { draft, fields: ["age", "name"], lockedFields: ["name"] } }), worldCtx(world.id)));
    expect(one.body.draft).toMatchObject({ name: "고정", personalityTags: ["kind"], characterContext: "유지", goal: "" });
    expect(one.body.draft.age).toBeGreaterThanOrEqual(1);
    expect(one.body.draft.age).toBeLessThanOrEqual(80);

    expect(await prisma.character.count({ where: { worldId: world.id } })).toBe(0);
    expect(await changeSeq(world.id)).toBe(0);
  });
});
