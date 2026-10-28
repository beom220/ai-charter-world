import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as START } from "@/app/api/worlds/[worldId]/simulation/start/route";
import { GET as STATE } from "@/app/api/worlds/[worldId]/simulation/state/route";
import { AUTH_ENV_KEYS, readAuthEnv } from "@/server/auth/env";
import { authOptions } from "@/server/auth/options";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { runSimulationCommand, settlePausing, updateSimulationSettings } from "@/server/domain/simulation/control";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// 시뮬레이션 실행 제어 (Phase 5-4-1). 상태 전이·중복 명령·소유권·세계관 격리·outbox 원자성. Gemini 호출 없음.

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "simulation-fingerprint-secret-0123456789",
});

async function setup(label: string, opts: { characters?: number } = {}) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  await saveGeminiApiKey(uid, fakeGeminiKey(label), material);
  await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
  const world = await createTestWorld(user.id, `${label} 세계`);
  for (let i = 0; i < (opts.characters ?? 2); i++) await prisma.character.create({ data: characterData(world.id, `${label}-${i + 1}`) });
  return { user, uid, world };
}

const runtime = (worldId: string) => prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId } });
const statusEvents = (worldId: string) =>
  prisma.simulationEvent.findMany({ where: { worldId, type: "runtime.status" }, orderBy: { id: "asc" } }).then((rows) => rows.map((r) => (r.payload as { status: string }).status));

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("실행 제어 서비스", () => {
  it("start → pause → resume → stop 전이, 반복 명령은 noop, 허용되지 않는 전이는 409", async () => {
    const { uid, world } = await setup("sim-cycle");
    const cmd = (c: "start" | "pause" | "resume" | "stop") => runSimulationCommand(uid, world.id, c);
    await expect(cmd("pause")).rejects.toMatchObject({ status: 409, code: "INVALID_TRANSITION" });
    await expect(cmd("resume")).rejects.toMatchObject({ status: 409, code: "INVALID_TRANSITION" });

    const started = await cmd("start");
    expect(started).toMatchObject({ changed: true, state: { status: "RUNNING", statusReason: "USER", inFlight: false } });
    expect(started.state.runId).toBeTruthy();
    expect(await cmd("start")).toMatchObject({ changed: false, state: { status: "RUNNING", runId: started.state.runId } });

    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { leaseOwner: "worker-x", leaseExpiresAt: new Date() } });
    expect(await cmd("pause")).toMatchObject({ changed: true, state: { status: "PAUSED" } });
    expect(await runtime(world.id)).toMatchObject({ leaseOwner: null, leaseExpiresAt: null }); // PAUSED는 lease 해제
    expect((await cmd("pause")).changed).toBe(false);
    await expect(cmd("start")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    expect(await cmd("resume")).toMatchObject({ changed: true, state: { status: "RUNNING", runId: started.state.runId } }); // 같은 Run

    const before = await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } });
    expect(await cmd("stop")).toMatchObject({ changed: true, state: { status: "IDLE", runId: null } });
    const after = await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } });
    expect(after.stateVersion).toBe(before.stateVersion + 1); // 펜싱
    expect(after.changeSeq).toBe(before.changeSeq);
    expect((await prisma.simulationRun.findUniqueOrThrow({ where: { id: started.state.runId! } })).endedAt).not.toBeNull();
    expect((await cmd("stop")).changed).toBe(false);

    // 바뀐 명령마다 outbox에 상태 이벤트 1건
    expect(await statusEvents(world.id)).toEqual(["RUNNING", "PAUSED", "RUNNING", "IDLE"]);
  });

  it("진행 중 장면이 있으면 PAUSING이 되고, 장면이 끝나면 PAUSED로 마무리한다", async () => {
    const { uid, world } = await setup("sim-pausing");
    await runSimulationCommand(uid, world.id, "start");
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { inFlightAttemptId: "attempt-1", inFlightStartedAt: new Date() } });
    expect((await runSimulationCommand(uid, world.id, "pause")).state).toMatchObject({ status: "PAUSING", inFlight: true });
    await expect(runSimulationCommand(uid, world.id, "resume")).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    await settlePausing(world.id); // 아직 진행 중 → 그대로
    expect((await runtime(world.id)).status).toBe("PAUSING");
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { inFlightAttemptId: null, inFlightStartedAt: null } });
    await settlePausing(world.id);
    expect((await runtime(world.id)).status).toBe("PAUSED");
    expect(await statusEvents(world.id)).toEqual(["RUNNING", "PAUSING", "PAUSED"]);
  });

  it("동시 start 5건은 Run 1개·상태 이벤트 1건만 만들고, 다른 세계관에는 영향이 없다", async () => {
    const { uid, world } = await setup("sim-race");
    const other = await createTestWorld(uid, "sim-race 다른 세계");
    const results = await Promise.all(Array.from({ length: 5 }, () => runSimulationCommand(uid, world.id, "start")));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.state.runId)).size).toBe(1);
    expect(await prisma.simulationRun.count({ where: { worldId: world.id } })).toBe(1);
    expect(await statusEvents(world.id)).toEqual(["RUNNING"]);

    expect((await runtime(other.id)).status).toBe("IDLE");
    expect(await prisma.simulationEvent.count({ where: { worldId: other.id } })).toBe(0);
  });

  it("사전 조건 실패(활성 캐릭터 1명·연결 미검증)는 상태·Run·outbox를 바꾸지 않는다", async () => {
    const one = await setup("sim-precheck", { characters: 1 });
    await expect(runSimulationCommand(one.uid, one.world.id, "start")).rejects.toMatchObject({ status: 409, code: "NOT_ENOUGH_CHARACTERS" });

    const unverified = await setup("sim-unverified");
    await prisma.aiProviderConnection.updateMany({ where: { userId: unverified.user.id }, data: { status: "UNVERIFIED" } });
    await expect(runSimulationCommand(unverified.uid, unverified.world.id, "start")).rejects.toMatchObject({ status: 409 });

    for (const w of [one.world.id, unverified.world.id]) {
      expect((await runtime(w)).status).toBe("IDLE");
      expect(await prisma.simulationRun.count({ where: { worldId: w } })).toBe(0);
      expect(await prisma.simulationEvent.count({ where: { worldId: w } })).toBe(0);
    }
  });

  it("실행 속도는 바뀐 경우에만 저장·changeSeq+1·상태 이벤트를 남기고, 타인 세계관은 404", async () => {
    const { uid, world } = await setup("sim-speed");
    const intruder = await setup("sim-speed-intruder");
    expect(await updateSimulationSettings(uid, world.id, "FAST")).toMatchObject({ changed: true, state: { intervalPreset: "FAST" } });
    expect((await updateSimulationSettings(uid, world.id, "FAST")).changed).toBe(false);
    expect((await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } })).changeSeq).toBe(1);
    expect(await statusEvents(world.id)).toEqual(["IDLE"]);
    await expect(updateSimulationSettings(intruder.uid, world.id, "SLOW")).rejects.toMatchObject({ status: 404 });
    await expect(runSimulationCommand(intruder.uid, world.id, "start")).rejects.toMatchObject({ status: 404 });
    expect((await runtime(world.id)).status).toBe("IDLE");
  });
});

describe("시뮬레이션 Route Handler", () => {
  const BASE_URL = "http://localhost:3000";
  const ENV = {
    BETTER_AUTH_SECRET: "simulation-route-test-secret-0123456789abcdef",
    BETTER_AUTH_URL: BASE_URL,
    GOOGLE_CLIENT_ID: "simulation-route-test.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "simulation-route-test-client-secret",
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

  const headersFor = async (userId?: string) => {
    const headers = new Headers({ origin: BASE_URL });
    if (userId) headers.set("cookie", (await (await testAuth.$context).test.login({ userId })).headers.get("cookie")!);
    return headers;
  };

  it("비로그인 401, 타인 세계관 404, 소유자는 start 후 상태 조회", async () => {
    const owner = await setup("sim-route-owner");
    const intruder = await createTestUser("sim-route-intruder");
    const params = { params: Promise.resolve({ worldId: owner.world.id }) };
    const url = (p: string) => `${BASE_URL}/api/worlds/${owner.world.id}/simulation/${p}`;

    expect((await START(new Request(url("start"), { method: "POST", headers: await headersFor() }), params)).status).toBe(401);
    expect((await START(new Request(url("start"), { method: "POST", headers: await headersFor(intruder.id) }), params)).status).toBe(404);
    expect((await STATE(new Request(url("state"), { headers: await headersFor(intruder.id) }), params)).status).toBe(404);
    expect((await runtime(owner.world.id)).status).toBe("IDLE");

    expect((await START(new Request(url("start"), { method: "POST", headers: await headersFor(owner.user.id) }), params)).status).toBe(200);
    const res = await STATE(new Request(url("state"), { headers: await headersFor(owner.user.id) }), params);
    expect(await res.json()).toMatchObject({ state: { status: "RUNNING", intervalPreset: "NORMAL" } });
  });
});
