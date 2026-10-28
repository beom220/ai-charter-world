import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { RuntimeStatus } from "@/generated/prisma/client";
import type { CharacterInput } from "@/lib/schemas/character";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { createCharacter, deleteCharacter, updateCharacter } from "@/server/domain/characters/characters";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { createManualSave, loadSave } from "@/server/domain/saves/saves";
import { generateScene, prepareScene } from "@/server/domain/scenes/generate-scene";
import { runSimulationCommand, updateSimulationSettings } from "@/server/domain/simulation/control";
import { getWorld, updateWorld } from "@/server/domain/worlds";
import { claimAttempt, runWorldTick } from "@/server/engine/runner/world-tick";
import type { GeminiKeyClient } from "@/server/llm/gemini/client";
import { createMockGeminiClient } from "@/server/llm/mock/gemini-mock";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// 설정 변경 정책 (Phase 7-2). 실제 DB + Mock Gemini.
// - 캐릭터 생성·수정·삭제: RUNNING·PAUSING, PAUSED + 진행 중 장면이면 409. IDLE, 진행 중 장면 없는 PAUSED는 허용
// - 세계관: 장면 0개면 위 규칙, 장면 1개 이상이면 모든 실행 상태에서 409 WORLD_SETTINGS_LOCKED (불러오기 후 장면 수 기준)
// - 일시정지 중 바꾼 캐릭터 설정은 재개 후 다음 프롬프트에 반영되고, 준비 이후 바뀐 설정으로는 시도를 기록하지 않는다

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "settings-lock-fingerprint-0123456789",
});

const input = (name: string, over: Partial<CharacterInput> = {}): CharacterInput => ({
  name,
  gender: "FEMALE",
  age: 30,
  personalityTags: ["reserved", "cautious", "sensitive"],
  goal: "",
  characterContext: "",
  childhoodBackgroundId: "childhood_bookworm",
  adulthoodBackgroundId: "adulthood_scientist",
  ...over,
});

const WORLD_EDIT = { name: "무인도", worldContext: "배가 난파해 무인도에 표류했다." };

/** 사용자·세계관·캐릭터 2명·Mock 연결. 보낸 프롬프트를 기록한다 */
async function setup(label: string) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  await saveGeminiApiKey(uid, fakeGeminiKey(label), material);
  await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
  const world = await createTestWorld(user.id, "코로나19 도시");
  await prisma.world.update({ where: { id: world.id }, data: { worldContext: "코로나19가 퍼진 도시의 격리 병동." } });
  const chars = [];
  for (let i = 0; i < 2; i++) chars.push(await prisma.character.create({ data: characterData(world.id, `인물${i + 1}`) }));
  await prisma.sseConnection.create({ data: { worldId: world.id, userId: user.id, instanceId: "test", lastSeenAt: new Date("2100-01-01T00:00:00.000Z") } });
  const prompts: string[] = [];
  const mock = createMockGeminiClient();
  const client: GeminiKeyClient = {
    ...mock.client,
    generateJson: (apiKey, request, meter) => {
      prompts.push(request.prompt);
      return mock.client.generateJson(apiKey, request, meter);
    },
  };
  const clock = { ms: Date.parse("2026-10-28T03:00:00.000Z") };
  const deps = { client, material, now: () => new Date(clock.ms) };
  return { user, uid, world, chars, prompts, clock, deps };
}

const setRuntime = (worldId: string, status: RuntimeStatus, inFlight: boolean) =>
  prisma.simulationRuntime.update({
    where: { worldId },
    data: { status, inFlightAttemptId: inFlight ? `attempt-${randomUUID()}` : null, inFlightStartedAt: inFlight ? new Date() : null },
  });

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("설정 수정 가능 상태 (장면 0개)", () => {
  const cases: { status: RuntimeStatus; inFlight: boolean; allowed: boolean }[] = [
    { status: "RUNNING", inFlight: false, allowed: false },
    { status: "PAUSING", inFlight: true, allowed: false },
    { status: "PAUSED", inFlight: true, allowed: false },
    { status: "PAUSED", inFlight: false, allowed: true },
    { status: "IDLE", inFlight: false, allowed: true },
  ];

  it.each(cases)("$status (진행 중 장면 $inFlight) → 허용 $allowed", async ({ status, inFlight, allowed }) => {
    const user = await createTestUser(`lock-${status}-${inFlight}`);
    const uid = asAuthenticatedUserId(user.id);
    const world = await createTestWorld(user.id, "코로나19 도시");
    const target = await prisma.character.create({ data: characterData(world.id, "수정 대상") });
    const victim = await prisma.character.create({ data: characterData(world.id, "삭제 대상") });
    await setRuntime(world.id, status, inFlight);
    const before = await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } });

    const ops = [
      () => updateWorld(uid, world.id, WORLD_EDIT),
      () => createCharacter(uid, world.id, input("새 인물")),
      () => updateCharacter(uid, world.id, target.id, input("바뀐 이름")),
      () => deleteCharacter(uid, world.id, victim.id),
    ];
    for (const op of ops) {
      if (allowed) await expect(op()).resolves.not.toThrow();
      else await expect(op()).rejects.toMatchObject({ status: 409, code: "SETTINGS_LOCKED" });
    }

    const after = await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } });
    const w = await prisma.world.findUniqueOrThrow({ where: { id: world.id } });
    if (allowed) {
      expect(w.name).toBe("무인도");
      expect(after.changeSeq).toBe(before.changeSeq + 4);
      expect(after.settingsSeq).toBe(before.settingsSeq + 4);
    } else {
      expect(w.name).toBe("코로나19 도시");
      expect(await prisma.character.count({ where: { worldId: world.id, deletedAt: null } })).toBe(2);
      expect(after.changeSeq).toBe(before.changeSeq);
      expect(after.settingsSeq).toBe(before.settingsSeq);
    }
  });
});

describe("세계관 설정 영구 잠금 (장면 1개 이상)", () => {
  it("첫 장면 뒤에는 모든 실행 상태에서 세계관 수정을 거부하고, 캐릭터 정책은 그대로다. 타인은 404", async () => {
    const { uid, world, chars, deps } = await setup("wlock-states");
    expect((await getWorld(uid, world.id)).settingsLocked).toBe(false);
    await generateScene(uid, world.id, deps);
    expect((await getWorld(uid, world.id)).settingsLocked).toBe(true);

    for (const [status, inFlight] of [["IDLE", false], ["PAUSED", false], ["PAUSED", true], ["PAUSING", true], ["RUNNING", false]] as const) {
      await setRuntime(world.id, status, inFlight);
      await expect(updateWorld(uid, world.id, WORLD_EDIT)).rejects.toMatchObject({ status: 409, code: "WORLD_SETTINGS_LOCKED" });
    }
    await setRuntime(world.id, "IDLE", false);
    await expect(updateCharacter(uid, world.id, chars[0]!.id, input("인물1"))).resolves.toMatchObject({ changed: true });
    expect(await prisma.world.findUniqueOrThrow({ where: { id: world.id } })).toMatchObject({ name: "코로나19 도시" });
    expect(await prisma.conversationScene.count({ where: { worldId: world.id } })).toBe(1);

    const other = await createTestUser("wlock-other");
    await expect(updateWorld(asAuthenticatedUserId(other.id), world.id, WORLD_EDIT)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("불러오기 후에는 복원된 장면 수로 판단한다 (장면 0개 세이브 → 풀림, 장면 있는 세이브 → 잠김)", async () => {
    const { uid, world, deps } = await setup("wlock-load");
    const empty = await createManualSave(uid, world.id, "장면 전");
    await generateScene(uid, world.id, deps);
    const withScene = await createManualSave(uid, world.id, "장면 후");

    await loadSave(uid, world.id, empty.id);
    expect((await getWorld(uid, world.id)).settingsLocked).toBe(false);
    await expect(updateWorld(uid, world.id, WORLD_EDIT)).resolves.toMatchObject({ changed: true });

    await loadSave(uid, world.id, withScene.id);
    expect((await getWorld(uid, world.id)).settingsLocked).toBe(true);
    await expect(updateWorld(uid, world.id, WORLD_EDIT)).rejects.toMatchObject({ code: "WORLD_SETTINGS_LOCKED" });
  });
});

describe("캐릭터 설정 변경 → 재개", () => {
  it("다음 프롬프트에 설정 B만 들어가고 이전 장면에는 변경 표시가 붙는다. 기존 장면·기억·관계는 남는다", async () => {
    const { uid, world, chars, prompts, clock, deps } = await setup("char-resume");
    const target = chars[0]!;
    await updateCharacter(uid, world.id, target.id, input("인물1"));
    const ctx = { owner: "host-a", deps, state: { failures: 0 } };

    await runSimulationCommand(uid, world.id, "start", deps.now);
    await runWorldTick(world.id, ctx);
    const block = (p: string) => p.split(`이름: 인물1`)[1]!.split("</character>")[0]!;
    expect(block(prompts[0]!)).toContain("내성적");
    expect(block(prompts[0]!)).toContain("책벌레");
    const memories = await prisma.characterMemory.count({ where: { worldId: world.id } });
    const relations = await prisma.relationshipState.count({ where: { worldId: world.id } });

    const settingB = input("인물1", { personalityTags: ["sociable", "impulsive", "adventurous"], childhoodBackgroundId: "childhood_street_urchin", adulthoodBackgroundId: "adulthood_bounty_hunter" });
    await expect(updateCharacter(uid, world.id, target.id, settingB)).rejects.toMatchObject({ code: "SETTINGS_LOCKED" });
    await runSimulationCommand(uid, world.id, "pause", deps.now);
    clock.ms += 1_000;
    await updateCharacter(uid, world.id, target.id, settingB);
    await runSimulationCommand(uid, world.id, "resume", deps.now);
    clock.ms += 60_000;
    await runWorldTick(world.id, ctx);

    expect(prompts).toHaveLength(2);
    const b = block(prompts[1]!);
    for (const s of ["사교적", "충동적", "모험적", "도시의 부랑아", "현상금 사냥꾼"]) expect(b).toContain(s);
    for (const s of ["내성적", "신중한", "책벌레", "과학자"]) expect(b).not.toContain(s);
    expect(prompts[1]).toContain("장면 #1까지는 현재 세계관·인물 설정으로 바뀌기 전의 기록이다");
    expect(await prisma.conversationScene.count({ where: { worldId: world.id } })).toBe(2);
    expect(await prisma.characterMemory.count({ where: { worldId: world.id } })).toBeGreaterThanOrEqual(memories);
    expect(await prisma.relationshipState.count({ where: { worldId: world.id } })).toBeGreaterThanOrEqual(relations);
  });

  it("준비 이후 settingsSeq가 바뀌면 시도를 기록하지 않는다. 속도 변경(changeSeq만 증가)은 막지 않는다", async () => {
    const { uid, world, deps } = await setup("claim-fence");
    await runSimulationCommand(uid, world.id, "start", deps.now);
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { leaseOwner: "host-a", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    const rt = await prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId: world.id } });
    const prepared = await prepareScene(uid, world.id, deps);

    // 실행 속도 변경은 changeSeq만 올린다 → 같은 준비로 기록해도 된다 (기록 후 해제)
    await updateSimulationSettings(uid, world.id, "FAST");
    const claimedId = randomUUID();
    expect(await claimAttempt(world.id, rt.currentRunId!, "host-a", prepared, claimedId, deps.now())).toBe(true);
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { inFlightAttemptId: null, inFlightStartedAt: null } });

    await prisma.$executeRaw`UPDATE "GameState" SET "settingsSeq" = "settingsSeq" + 1 WHERE "worldId" = ${world.id}`;
    expect(await claimAttempt(world.id, rt.currentRunId!, "host-a", prepared, randomUUID(), deps.now())).toBe(false);
    expect((await prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId: world.id } })).inFlightAttemptId).toBeNull();

    const fresh = await prepareScene(uid, world.id, deps);
    expect(await claimAttempt(world.id, rt.currentRunId!, "host-a", fresh, randomUUID(), deps.now())).toBe(true);
  });

  it("수동 생성: Gemini 호출 중(IDLE) 설정이 바뀌면 장면을 저장하지 않고 점유를 풀며, 호출 기록은 남는다", async () => {
    const { uid, world, chars, deps, prompts } = await setup("manual-fence");
    const edited: GeminiKeyClient = {
      ...deps.client,
      generateJson: async (apiKey, request, meter) => {
        // 호출이 진행 중인 IDLE 세계관: 설정 수정은 허용된다 (진행 중 장면 표시는 이 시도의 것)
        await updateCharacter(uid, world.id, chars[0]!.id, input("호출 중 수정"));
        return deps.client.generateJson(apiKey, request, meter);
      },
    };
    await expect(generateScene(uid, world.id, { ...deps, client: edited })).rejects.toMatchObject({ status: 409, code: "SETTINGS_CHANGED" });
    expect(prompts).toHaveLength(1);
    expect(await prisma.conversationScene.count({ where: { worldId: world.id } })).toBe(0);
    expect((await prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId: world.id } })).inFlightAttemptId).toBeNull();
    expect(await prisma.apiRequestLog.count({ where: { worldId: world.id } })).toBe(1);

    // 다시 시도하면 새 설정으로 준비해 저장한다. 수동·자동 중복 방지도 그대로다
    await generateScene(uid, world.id, deps);
    expect(prompts[1]).toContain("이름: 호출 중 수정");
    await runSimulationCommand(uid, world.id, "start", deps.now);
    await expect(generateScene(uid, world.id, deps)).rejects.toMatchObject({ code: "SCENE_IN_PROGRESS" });
  });

  it("수동 생성: 호출 중 실행 속도만 바뀌면(changeSeq만 증가) 장면을 그대로 저장한다", async () => {
    const { uid, world, deps } = await setup("manual-speed");
    const speedChanged: GeminiKeyClient = {
      ...deps.client,
      generateJson: async (apiKey, request, meter) => {
        await updateSimulationSettings(uid, world.id, "SLOW");
        return deps.client.generateJson(apiKey, request, meter);
      },
    };
    await expect(generateScene(uid, world.id, { ...deps, client: speedChanged })).resolves.toMatchObject({ seq: 1 });
  });
});
