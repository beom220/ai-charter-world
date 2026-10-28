import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { RuntimeStatus } from "@/generated/prisma/client";
import type { CharacterInput } from "@/lib/schemas/character";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { createCharacter, deleteCharacter, updateCharacter } from "@/server/domain/characters/characters";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { runSimulationCommand } from "@/server/domain/simulation/control";
import { updateWorld } from "@/server/domain/worlds";
import { runWorldTick } from "@/server/engine/runner/world-tick";
import type { GeminiKeyClient } from "@/server/llm/gemini/client";
import { createMockGeminiClient } from "@/server/llm/mock/gemini-mock";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// 실행 중 설정 변경 정책 (Phase 7-2). 실제 DB + Mock Gemini.
// - RUNNING·PAUSING, PAUSED + 진행 중 장면이면 세계관 수정·캐릭터 생성/수정/삭제를 409로 거부하고 아무것도 바꾸지 않는다
// - IDLE, 진행 중 장면 없는 PAUSED는 허용한다
// - 일시정지 중 바꾼 설정은 재개 후 다음 장면 프롬프트에 반영되고, 기존 장면·기억은 남는다

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "settings-lock-fingerprint-0123456789",
});

const input = (name: string): CharacterInput => ({
  name,
  gender: "FEMALE",
  age: 30,
  personalityTags: ["sociable", "talkative", "reserved"].slice(0, 3),
  goal: "",
  characterContext: "",
  childhoodBackgroundId: "childhood_farm",
  adulthoodBackgroundId: "adulthood_farmer",
});

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("설정 수정 가능 상태", () => {
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
    await prisma.simulationRuntime.update({
      where: { worldId: world.id },
      data: { status, inFlightAttemptId: inFlight ? "attempt-x" : null, inFlightStartedAt: inFlight ? new Date() : null },
    });
    const before = await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } });

    const ops = [
      () => updateWorld(uid, world.id, { name: "무인도", worldContext: "무인도에 표류했다." }),
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
    const active = await prisma.character.count({ where: { worldId: world.id, deletedAt: null } });
    if (allowed) {
      expect(w.name).toBe("무인도");
      expect(after.changeSeq).toBe(before.changeSeq + 4);
    } else {
      expect(w.name).toBe("코로나19 도시");
      expect(active).toBe(2);
      expect(after.changeSeq).toBe(before.changeSeq);
      expect((await prisma.character.findUniqueOrThrow({ where: { id: target.id } })).name).toBe("수정 대상");
    }
  });
});

describe("일시정지 중 설정 변경 → 재개", () => {
  it("다음 장면 프롬프트에 새 세계관이 들어가고 이전 장면에는 설정 변경 표시가 붙는다. 기존 장면·기억은 남는다", async () => {
    const user = await createTestUser("lock-resume");
    const uid = asAuthenticatedUserId(user.id);
    await saveGeminiApiKey(uid, fakeGeminiKey("lock-resume"), material);
    await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
    const world = await createTestWorld(user.id, "코로나19 도시");
    await prisma.world.update({ where: { id: world.id }, data: { worldContext: "코로나19가 퍼진 도시의 격리 병동." } });
    for (let i = 0; i < 2; i++) await prisma.character.create({ data: characterData(world.id, `인물${i + 1}`) });
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
    const ctx = { owner: "host-a", deps, state: { failures: 0 } };

    await runSimulationCommand(uid, world.id, "start", deps.now);
    await runWorldTick(world.id, ctx);
    expect(prompts[0]).toContain("격리 병동");
    const memoriesBefore = await prisma.characterMemory.count({ where: { worldId: world.id } });

    // 일시정지(진행 중 장면 없음 → PAUSED) 후 세계관 교체. 실행 중이면 거부된다
    await expect(updateWorld(uid, world.id, { name: "무인도", worldContext: "배가 난파해 무인도에 표류했다." })).rejects.toMatchObject({ code: "SETTINGS_LOCKED" });
    await runSimulationCommand(uid, world.id, "pause", deps.now);
    clock.ms += 1_000;
    await updateWorld(uid, world.id, { name: "무인도", worldContext: "배가 난파해 무인도에 표류했다." });
    await runSimulationCommand(uid, world.id, "resume", deps.now);
    clock.ms += 60_000;
    await runWorldTick(world.id, ctx);

    expect(prompts).toHaveLength(2);
    const world2 = prompts[1]!.split("</world>")[0]!;
    expect(world2).toContain("무인도에 표류했다");
    expect(world2).not.toContain("격리 병동");
    expect(prompts[1]).toContain("장면 #1까지는 현재 세계관·인물 설정으로 바뀌기 전의 기록이다");
    expect(await prisma.conversationScene.count({ where: { worldId: world.id } })).toBe(2);
    expect(await prisma.characterMemory.count({ where: { worldId: world.id } })).toBeGreaterThanOrEqual(memoriesBefore);
  });
});
