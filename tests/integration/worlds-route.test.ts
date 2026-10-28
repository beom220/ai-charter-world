import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_REQUEST_BODY_BYTES } from "../../config/limits";
import { DELETE, GET as GET_ONE, PATCH } from "@/app/api/worlds/[worldId]/route";
import { GET as LIST, POST } from "@/app/api/worlds/route";
import { AUTH_ENV_KEYS, readAuthEnv } from "@/server/auth/env";
import { authOptions } from "@/server/auth/options";
import { prisma } from "@/server/db/client";
import { characterData, cleanupTestUsers, createTestUser } from "./helpers";

// /api/worlds Route Handler를 실제 Better Auth 세션 쿠키로 호출한다 (Phase 4-1, PRD FR-03).

const BASE_URL = "http://localhost:3000";
const ENV = {
  BETTER_AUTH_SECRET: "worlds-route-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: BASE_URL,
  GOOGLE_CLIENT_ID: "worlds-route-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "worlds-route-test-client-secret",
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

function req(method: string, path: string, init: { cookie?: string; body?: unknown; rawBody?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json", origin: BASE_URL });
  if (init.cookie) headers.set("cookie", init.cookie);
  const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return new Request(`${BASE_URL}${path}`, { method, headers, body });
}

const ctx = (worldId: string) => ({ params: Promise.resolve({ worldId }) });

async function json(res: Response) {
  return { status: res.status, body: await res.json() };
}

async function createVia(cookie: string, name: string, worldContext = "배경") {
  const r = await json(await POST(req("POST", "/api/worlds", { cookie, body: { name, worldContext } })));
  expect(r.status).toBe(201);
  return r.body.world as { id: string; name: string; worldContext: string; runtimeStatus: string };
}

describe("세계관 CRUD", () => {
  it("비로그인 요청은 401", async () => {
    expect((await LIST(req("GET", "/api/worlds"))).status).toBe(401);
    expect((await POST(req("POST", "/api/worlds", { body: { name: "x", worldContext: "" } }))).status).toBe(401);
    expect((await GET_ONE(req("GET", "/api/worlds/any"), ctx("any"))).status).toBe(401);
  });

  it("생성: World·GameState·SimulationRuntime(IDLE)·복구 지점 SaveGame(RECOVERY, 스냅샷 없음)을 함께 만들고, 본문의 ownerId는 무시한다", async () => {
    const user = await createTestUser("world-create");
    const other = await createTestUser("world-create-other");
    const cookie = await loginCookie(user.id);
    const r = await json(await POST(req("POST", "/api/worlds", { cookie, body: { name: "  무인도  ", worldContext: "긴 배경", ownerId: other.id } })));
    expect(r.status).toBe(201);
    expect(r.body.world).toMatchObject({ name: "무인도", worldContext: "긴 배경", runtimeStatus: "IDLE" });

    const world = await prisma.world.findUniqueOrThrow({
      where: { id: r.body.world.id },
      include: { gameState: true, runtime: true, saveGames: true },
    });
    expect(world.ownerId).toBe(user.id);
    expect(world.gameState).toMatchObject({ stateVersion: 0, changeSeq: 0 });
    expect(world.runtime?.status).toBe("IDLE");
    expect(world.saveGames).toHaveLength(1);
    expect(world.saveGames[0]).toMatchObject({ kind: "RECOVERY", recoveryForWorldId: world.id, snapshotId: null, worldNameSnapshot: "무인도" });
  });

  it("빈 이름은 400", async () => {
    const user = await createTestUser("world-invalid");
    const r = await POST(req("POST", "/api/worlds", { cookie: await loginCookie(user.id), body: { name: "   ", worldContext: "" } }));
    expect(r.status).toBe(400);
  });

  it("10MB를 넘는 본문은 413이고 아무것도 만들지 않는다", async () => {
    const user = await createTestUser("world-big");
    const cookie = await loginCookie(user.id);
    const rawBody = JSON.stringify({ name: "큰 세계", worldContext: "a".repeat(MAX_REQUEST_BODY_BYTES) });
    const r = await json(await POST(req("POST", "/api/worlds", { cookie, rawBody })));
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(await prisma.world.count({ where: { ownerId: user.id } })).toBe(0);

    // 한도 안의 큰 컨텍스트는 저장된다 (글자 수 제한 없음)
    const big = "가".repeat(1_000_000); // UTF-8 3MB
    const ok = await createVia(cookie, "큰 세계", big);
    expect(ok.worldContext.length).toBe(big.length);
  });

  it("목록·상세는 본인 것만, 타인 세계관의 조회·수정·삭제는 404이고 데이터는 그대로다", async () => {
    const owner = await createTestUser("world-owner");
    const intruder = await createTestUser("world-intruder");
    const ownerCookie = await loginCookie(owner.id);
    const intruderCookie = await loginCookie(intruder.id);
    const world = await createVia(ownerCookie, "주인 세계");
    await createVia(intruderCookie, "침입자 세계");

    const ownerList = await json(await LIST(req("GET", "/api/worlds", { cookie: ownerCookie })));
    expect(ownerList.body.worlds.map((w: { name: string }) => w.name)).toEqual(["주인 세계"]);
    expect(ownerList.body.worlds[0]).not.toHaveProperty("worldContext");
    const intruderList = await json(await LIST(req("GET", "/api/worlds", { cookie: intruderCookie })));
    expect(intruderList.body.worlds.map((w: { name: string }) => w.name)).toEqual(["침입자 세계"]);

    const path = `/api/worlds/${world.id}`;
    expect((await GET_ONE(req("GET", path, { cookie: intruderCookie }), ctx(world.id))).status).toBe(404);
    expect((await PATCH(req("PATCH", path, { cookie: intruderCookie, body: { name: "탈취", worldContext: "" } }), ctx(world.id))).status).toBe(404);
    expect((await DELETE(req("DELETE", path, { cookie: intruderCookie }), ctx(world.id))).status).toBe(404);

    const after = await prisma.world.findUniqueOrThrow({ where: { id: world.id }, include: { gameState: true } });
    expect(after.name).toBe("주인 세계");
    expect(after.gameState?.changeSeq).toBe(0);
    expect((await GET_ONE(req("GET", path, { cookie: ownerCookie }), ctx(world.id))).status).toBe(200);
  });

  it("수정: 실제 변경이 있을 때만 changeSeq를 올리고 stateVersion은 그대로다", async () => {
    const user = await createTestUser("world-update");
    const cookie = await loginCookie(user.id);
    const world = await createVia(cookie, "원래 이름", "원래 배경");
    const path = `/api/worlds/${world.id}`;

    const changed = await json(await PATCH(req("PATCH", path, { cookie, body: { name: "새 이름", worldContext: "새 배경" } }), ctx(world.id)));
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ changed: true, world: { name: "새 이름", worldContext: "새 배경" } });

    const same = await json(await PATCH(req("PATCH", path, { cookie, body: { name: "새 이름", worldContext: "새 배경" } }), ctx(world.id)));
    expect(same.body.changed).toBe(false);

    const state = await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } });
    expect(state).toMatchObject({ changeSeq: 1, stateVersion: 0 });
  });

  it("삭제: 실행 중이어도 삭제하고 하위 데이터(상태·런타임·세이브·캐릭터)를 모두 지운다", async () => {
    const user = await createTestUser("world-delete");
    const cookie = await loginCookie(user.id);
    const world = await createVia(cookie, "지울 세계");
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { status: "RUNNING" } });
    await prisma.character.create({ data: characterData(world.id) });
    const snapshot = await prisma.gameSnapshot.create({
      data: { worldId: world.id, schemaVersion: 1, payload: { schemaVersion: 1 }, sizeBytes: 17, checksum: "0".repeat(64) },
    });
    await prisma.saveGame.create({
      data: {
        worldId: world.id,
        kind: "MANUAL",
        name: "슬롯",
        snapshotId: snapshot.id,
        sceneCount: 0,
        characterCount: 1,
        worldNameSnapshot: "지울 세계",
        stateVersionAtSave: 0,
      },
    });

    const r = await json(await DELETE(req("DELETE", `/api/worlds/${world.id}`, { cookie }), ctx(world.id)));
    expect(r).toEqual({ status: 200, body: { deleted: true } });

    const where = { worldId: world.id };
    expect(await prisma.world.count({ where: { id: world.id } })).toBe(0);
    expect(await prisma.gameState.count({ where })).toBe(0);
    expect(await prisma.simulationRuntime.count({ where })).toBe(0);
    expect(await prisma.saveGame.count({ where })).toBe(0);
    expect(await prisma.gameSnapshot.count({ where })).toBe(0);
    expect(await prisma.character.count({ where })).toBe(0);

    expect((await DELETE(req("DELETE", `/api/worlds/${world.id}`, { cookie }), ctx(world.id))).status).toBe(404);
  });
});
