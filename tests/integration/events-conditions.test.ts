import { afterAll, describe, expect, it } from "vitest";
import { MAX_ACTIVE_CHARACTERS_PER_WORLD } from "../../config/limits";
import type { CharacterInput } from "@/lib/schemas/character";
import { prisma } from "@/server/db/client";
import { createCharacter, listCharacters } from "@/server/domain/characters/characters";
import { ensureAutoEventPeriod } from "@/server/domain/events/auto-periods";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { createManualSave, loadSave } from "@/server/domain/saves/saves";
import { cleanupTestUsers, createTestUser, createTestWorld, testAvatar } from "./helpers";

// Phase 7-2-1: 자동 사건 구간 추첨 영속화(동시성·재판정), 사망자 슬롯 불변식, 사용자 사건 멱등 키, 사건·구간·신체 상태 저장·불러오기. 실제 DB.

const input = (name: string): CharacterInput => ({
  name,
  gender: "MALE",
  age: 40,
  personalityTags: ["calm", "honest", "diligent"],
  characterContext: "",
  childhoodBackgroundId: "childhood_farm",
  adulthoodBackgroundId: "adulthood_farmer",
  avatarId: testAvatar("MALE", name),
});

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("자동 사건 20장면 구간", () => {
  it("동시 판정·재시작·다른 난수에도 구간당 한 행·한 결과만 남고, 예약 장면에 도달해야 발생 대상이 된다", async () => {
    const user = await createTestUser("period");
    const world = await createTestWorld(user.id);
    const decide = (sceneSeq: number, r: number) =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "World" WHERE "id" = ${world.id} FOR UPDATE`;
        return ensureAutoEventPeriod(tx, world.id, sceneSeq, () => r);
      });

    expect(await decide(2, 0)).toBeNull(); // #3 전에는 판정하지 않는다
    // 첫 판정(난수 0 → 당첨, 예약 = 현재 장면 #5)과 동시에 다른 난수로 판정해도 한 행만 남는다
    const results = await Promise.all([decide(5, 0), decide(5, 0.99), decide(5, 0.5)]);
    expect(await prisma.worldEventPeriod.count({ where: { worldId: world.id } })).toBe(1);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    const first = results[0]!;

    // 재시작 후 같은 구간 판정은 저장된 결과 그대로 (다시 추첨하지 않는다)
    expect(await decide(10, 0.99)).toEqual({ ...first, dueNow: first.won && first.scheduledSceneSeq! <= 10 });
    // 다음 구간(#23~)은 따로 한 번
    const next = await decide(23, 0.99);
    expect(next).toMatchObject({ periodIndex: 1, won: false, scheduledSceneSeq: null, dueNow: false });
    expect(await prisma.worldEventPeriod.count({ where: { worldId: world.id } })).toBe(2);
  });

  it("당첨 구간의 예약 장면 전에는 발생 대상이 아니고, 발생 처리(firedAt) 후에는 다시 대상이 되지 않는다", async () => {
    const user = await createTestUser("period-due");
    const world = await createTestWorld(user.id);
    await prisma.worldEventPeriod.create({ data: { worldId: world.id, periodIndex: 0, won: true, scheduledSceneSeq: 10 } });
    const at = (s: number) => prisma.$transaction((tx) => ensureAutoEventPeriod(tx, world.id, s, () => 0));
    expect(await at(9)).toMatchObject({ dueNow: false });
    expect(await at(10)).toMatchObject({ dueNow: true });
    await prisma.worldEventPeriod.update({ where: { worldId_periodIndex: { worldId: world.id, periodIndex: 0 } }, data: { firedAt: new Date() } });
    expect(await at(11)).toMatchObject({ dueNow: false });
  });
});

describe("캐릭터 신체 상태와 슬롯", () => {
  it("새 캐릭터는 생존·정상·부상 없음으로 시작하고, 사망자도 목록에 남아 활성 6명 슬롯을 차지한다", async () => {
    const user = await createTestUser("dead-slot");
    const uid = asAuthenticatedUserId(user.id);
    const world = await createTestWorld(user.id);
    const created: Awaited<ReturnType<typeof createCharacter>>[] = [];
    for (let i = 0; i < MAX_ACTIVE_CHARACTERS_PER_WORLD; i++) created.push(await createCharacter(uid, world.id, input(`인물${i}`)));
    expect(created[0]!.condition).toMatchObject({ vital: "ALIVE", thermalCause: "NONE", thermalLevel: "NONE", painLevel: "NONE", injury: "NONE" });

    await prisma.characterCondition.update({
      where: { characterId: created[0]!.id },
      data: { vital: "DEAD", deathCause: "맹수 습격", deathSceneSeq: 4, diedAt: new Date() },
    });
    const listed = await listCharacters(uid, world.id);
    expect(listed).toHaveLength(MAX_ACTIVE_CHARACTERS_PER_WORLD);
    expect(listed.find((c) => c.id === created[0]!.id)?.condition).toMatchObject({ vital: "DEAD", deathCause: "맹수 습격" });
    await expect(createCharacter(uid, world.id, input("일곱째"))).rejects.toMatchObject({ code: "CHARACTER_LIMIT" });

    // 사망 기록 없는 사망·원인 없는 부상은 DB가 거부한다
    await expect(prisma.characterCondition.update({ where: { characterId: created[1]!.id }, data: { vital: "DEAD" } })).rejects.toThrow(/character_condition_death_record/);
    await expect(prisma.characterCondition.update({ where: { characterId: created[1]!.id }, data: { injury: "MILD" } })).rejects.toThrow(/character_condition_injury_cause/);
  });
});

describe("사건 저장·불러오기", () => {
  it("사용자 사건 requestId는 세계관 안에서 UNIQUE이고, 사건·구간·신체 상태·변화 이력이 저장 시점으로 정확히 복원된다", async () => {
    const user = await createTestUser("event-save");
    const uid = asAuthenticatedUserId(user.id);
    const world = await createTestWorld(user.id);
    const other = await createTestWorld(user.id, "다른 세계관");
    const [a, b] = [await createCharacter(uid, world.id, input("가")), await createCharacter(uid, world.id, input("나"))];

    const pending = { worldId: world.id, kind: "USER_INTERVENTION" as const, status: "PENDING" as const, title: "상인 방문", description: "낯선 상인이 찾아온다", requestId: "req-1" };
    await prisma.worldEvent.create({ data: pending });
    await expect(prisma.worldEvent.create({ data: pending })).rejects.toMatchObject({ code: "P2002" });
    await prisma.worldEvent.create({ data: { ...pending, worldId: other.id } }); // 다른 세계관은 같은 키 허용
    await expect(prisma.worldEvent.create({ data: { ...pending, requestId: "long", description: "가".repeat(201) } })).rejects.toThrow(/world_event_user_text_length/);

    const random = await prisma.worldEvent.create({
      data: { worldId: world.id, kind: "RANDOM", status: "ACTIVE", presetId: "creature_attack", intensity: "HIGH", title: "야생동물 습격", description: "늑대 무리", startedSceneSeq: 3, lastSceneSeq: 4 },
    });
    await prisma.worldEventPeriod.create({ data: { worldId: world.id, periodIndex: 0, won: true, scheduledSceneSeq: 3, presetId: "creature_attack", eventId: random.id, firedAt: new Date() } });
    await prisma.characterCondition.update({ where: { characterId: a.id }, data: {
        injury: "SEVERE",
        injuryCause: "늑대에게 물림",
        injurySceneSeq: 3,
        injuryUpdatedAtSeconds: 3600,
        painLevel: "SEVERE",
        painCause: "물린 상처",
        thermalCause: "COLD",
        thermalLevel: "EXTREME",
        thermalSinceSeconds: 3600,
        extremeSinceSeconds: 3600,
      },
    });
    await prisma.gameState.update({ where: { worldId: world.id }, data: { worldSeconds: 7200 } });
    await prisma.characterCondition.update({ where: { characterId: b.id }, data: { vital: "DEAD", deathCause: "늑대 습격", deathSceneSeq: 4, diedAt: new Date() } });
    await prisma.characterConditionChange.create({ data: { worldId: world.id, characterId: b.id, eventId: random.id, kind: "DEATH", fromValue: "ALIVE", toValue: "DEAD", reason: "늑대 습격" } });

    const state = async () => ({
      events: await prisma.worldEvent.findMany({ where: { worldId: world.id }, orderBy: { id: "asc" }, omit: { claimedAttemptId: true } }),
      periods: await prisma.worldEventPeriod.findMany({ where: { worldId: world.id } }),
      worldSeconds: (await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } })).worldSeconds,
      conditions: await prisma.characterCondition.findMany({ where: { worldId: world.id }, orderBy: { characterId: "asc" }, omit: { updatedAt: true } }),
      changes: await prisma.characterConditionChange.findMany({ where: { worldId: world.id } }),
    });
    const saved = await createManualSave(uid, world.id, "사건 진행 중");
    const expected = await state();

    // 저장 이후 변화: 구간 삭제, 사망자 부활 시도, 사건 해결
    await prisma.worldEventPeriod.deleteMany({ where: { worldId: world.id } });
    await prisma.gameState.update({ where: { worldId: world.id }, data: { worldSeconds: 99_999 } });
    await prisma.characterCondition.update({ where: { characterId: b.id }, data: { vital: "ALIVE", deathCause: null, deathSceneSeq: null, diedAt: null } });
    await prisma.worldEvent.update({ where: { id: random.id }, data: { status: "RESOLVED", resolutionSummary: "쫓아냄" } });

    await loadSave(uid, world.id, saved.id);
    expect(await state()).toEqual(expected);
    expect((await listCharacters(uid, world.id)).find((c) => c.id === b.id)?.condition.vital).toBe("DEAD");
  });
});
