import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as GET_ONE, PATCH } from "@/app/api/worlds/[worldId]/characters/[characterId]/route";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { createManualSave, loadSave } from "@/server/domain/saves/saves";
import { captureSnapshot, snapshotChecksum } from "@/server/domain/saves/snapshot";
import { POST } from "@/app/api/worlds/[worldId]/characters/route";
import { AUTH_ENV_KEYS, readAuthEnv } from "@/server/auth/env";
import { authOptions } from "@/server/auth/options";
import { prisma } from "@/server/db/client";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, testAvatar } from "./helpers";

// 캐릭터 배경 (Phase 7-1): API 필수·경계·잘못된 ID·나이 변경, 구버전 NULL 캐릭터 호환, 세이브(v2·v1) 복원. 실제 Better Auth 쿠키 + DB.

const BASE_URL = "http://localhost:3000";
const ENV = {
  BETTER_AUTH_SECRET: "character-bg-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: BASE_URL,
  GOOGLE_CLIENT_ID: "character-bg-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "character-bg-test-client-secret",
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

const body = (patch: Record<string, unknown> = {}) => ({
  name: "하윤",
  gender: "FEMALE",
  age: 27,
  personalityTags: ["sociable", "calm", "diligent"],
  goal: "",
  characterContext: "",
  childhoodBackgroundId: "childhood_fishing",
  adulthoodBackgroundId: "adulthood_chef",
  avatarId: testAvatar("FEMALE", typeof patch.name === "string" ? patch.name : "하윤"),
  ...patch,
});

async function setup(label: string) {
  const user = await createTestUser(label);
  const world = await createTestWorld(user.id);
  return { user, world, cookie: await loginCookie(user.id) };
}

const create = async (cookie: string, worldId: string, patch: Record<string, unknown> = {}) => {
  const res = await POST(req("POST", { cookie, body: body(patch) }), worldCtx(worldId));
  return { status: res.status, json: await res.json() };
};

describe("캐릭터 배경 API", () => {
  it("생성: 배경 ID를 저장하고, 필수 누락·잘못된 ID·18/19세 규칙 위반·자동 나이(성인)에 성년기 없음은 400", async () => {
    const { world, cookie } = await setup("bg-create");
    const ok = await create(cookie, world.id);
    expect(ok.status).toBe(201);
    expect(ok.json.character).toMatchObject({ childhoodBackgroundId: "childhood_fishing", adulthoodBackgroundId: "adulthood_chef" });

    const minor = await create(cookie, world.id, { name: "아이", age: 18, adulthoodBackgroundId: null });
    expect(minor.status).toBe(201);
    expect(minor.json.character.adulthoodBackgroundId).toBeNull();

    for (const patch of [
      { childhoodBackgroundId: undefined },
      { childhoodBackgroundId: "childhood_my_own_story" },
      { adulthoodBackgroundId: "adulthood_unknown" },
      { age: 18 },
      { age: 19, adulthoodBackgroundId: null },
      { age: null, adulthoodBackgroundId: null }, // 비우면 성인 자동 → 성년기 필수
    ]) {
      expect((await create(cookie, world.id, patch)).status).toBe(400);
    }
    expect(await prisma.character.count({ where: { worldId: world.id } })).toBe(2);
  });

  it("수정: 18세 이하로 내리면 성년기를 비워야 하고, 19세 이상으로 올리면 성년기를 요구한다. 타인 세계관은 404", async () => {
    const { world, cookie } = await setup("bg-update");
    const { json } = await create(cookie, world.id);
    const id = json.character.id as string;
    const patch = async (p: Record<string, unknown>) => (await PATCH(req("PATCH", { cookie, body: body(p) }), charCtx(world.id, id))).status;

    expect(await patch({ age: 15 })).toBe(400);
    expect(await patch({ age: 15, adulthoodBackgroundId: null })).toBe(200);
    expect(await prisma.character.findUniqueOrThrow({ where: { id } })).toMatchObject({ age: 15, adulthoodBackgroundId: null });
    expect(await patch({ age: null, adulthoodBackgroundId: null })).toBe(200); // 비우면 현재 나이(15) 유지
    expect(await patch({ age: 25, adulthoodBackgroundId: null })).toBe(400);
    expect(await patch({ age: 25, childhoodBackgroundId: "childhood_clone", adulthoodBackgroundId: "adulthood_dimension_explorer" })).toBe(200);
    expect(await prisma.character.findUniqueOrThrow({ where: { id } })).toMatchObject({ childhoodBackgroundId: "childhood_clone", adulthoodBackgroundId: "adulthood_dimension_explorer" });

    const intruder = await setup("bg-intruder");
    expect((await PATCH(req("PATCH", { cookie: intruder.cookie, body: body() }), charCtx(world.id, id))).status).toBe(404);
    expect((await create(intruder.cookie, world.id)).status).toBe(404);
  });

  it("배경이 없는 기존 캐릭터도 조회되고, 수정할 때는 선택해야 한다. DB도 18세 이하 성년기를 막는다", async () => {
    const { world, cookie } = await setup("bg-legacy");
    const legacy = await prisma.character.create({ data: characterData(world.id, "옛 캐릭터") });
    const res = await GET_ONE(req("GET", { cookie }), charCtx(world.id, legacy.id));
    expect(res.status).toBe(200);
    expect((await res.json()).character).toMatchObject({ childhoodBackgroundId: null, adulthoodBackgroundId: null });
    expect((await PATCH(req("PATCH", { cookie, body: body({ childhoodBackgroundId: null }) }), charCtx(world.id, legacy.id))).status).toBe(400);
    await expect(prisma.character.update({ where: { id: legacy.id }, data: { age: 10, adulthoodBackgroundId: "adulthood_chef" } })).rejects.toThrow(/character_adulthood_age/);
  });
});

describe("세이브 호환", () => {
  it("새 세이브는 배경을 담아 복원하고, 배경 없던 v1 세이브도 그대로 복원한다", async () => {
    const { user, world, cookie } = await setup("bg-save");
    const uid = asAuthenticatedUserId(user.id);
    const { json } = await create(cookie, world.id);
    const id = json.character.id as string;
    const saved = await createManualSave(uid, world.id, "배경 있음");

    await PATCH(req("PATCH", { cookie, body: body({ childhoodBackgroundId: "childhood_feral", adulthoodBackgroundId: "adulthood_hunter" }) }), charCtx(world.id, id));
    await loadSave(uid, world.id, saved.id);
    expect(await prisma.character.findUniqueOrThrow({ where: { id } })).toMatchObject({ childhoodBackgroundId: "childhood_fishing", adulthoodBackgroundId: "adulthood_chef" });

    // 구버전(v1) 세이브: 배경 필드가 없는 payload를 원래 checksum으로 저장
    const v2 = await prisma.$transaction((tx) => captureSnapshot(tx, world.id, new Date()));
    const v1 = {
      ...v2,
      schemaVersion: 1,
      characters: v2.characters.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "childhoodBackgroundId" && k !== "adulthoodBackgroundId"))),
    };
    const snapshot = await prisma.gameSnapshot.create({ data: { worldId: world.id, schemaVersion: 1, payload: v1, ...snapshotChecksum(v1) } });
    const old = await prisma.saveGame.create({
      data: { worldId: world.id, kind: "MANUAL", name: "v1", snapshotId: snapshot.id, sceneCount: 0, characterCount: 1, worldNameSnapshot: "w", stateVersionAtSave: 0 },
    });
    await loadSave(uid, world.id, old.id);
    expect(await prisma.character.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "하윤", childhoodBackgroundId: null, adulthoodBackgroundId: null });
    expect((await prisma.gameSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } })).schemaVersion).toBe(1); // 원본은 그대로
  });
});
