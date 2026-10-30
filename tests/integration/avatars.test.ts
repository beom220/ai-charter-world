import { afterAll, describe, expect, it } from "vitest";
import type { CharacterInput } from "@/lib/schemas/character";
import { prisma } from "@/server/db/client";
import { createCharacter, deleteCharacter, listUsedAvatarIds, updateCharacter } from "@/server/domain/characters/characters";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { createManualSave, loadSave } from "@/server/domain/saves/saves";
import { cleanupTestUsers, createTestUser, createTestWorld } from "./helpers";

// 프로필 일러스트 중복 금지 (같은 세계관 활성 캐릭터끼리 avatarId 공유 불가). 실제 DB.
// 사망자는 점유, 소프트 삭제는 해제, 다른 세계관은 허용, 동시 요청은 World 잠금으로 직렬화, 저장·불러오기는 avatarId 복원.

const input = (name: string, avatarId: string, gender: "FEMALE" | "MALE" = "FEMALE"): CharacterInput => ({
  name,
  gender,
  age: 30,
  personalityTags: ["calm", "honest", "diligent"],
  characterContext: "",
  childhoodBackgroundId: "childhood_city",
  adulthoodBackgroundId: "adulthood_doctor",
  avatarId,
});

async function setup(label: string) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  const world = await createTestWorld(user.id, `${label} 세계`);
  return { user, uid, world };
}

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("프로필 일러스트 중복 금지", () => {
  it("같은 세계관은 409(생성·수정), 자기 ID 유지는 허용, 다른 세계관은 같은 ID 허용", async () => {
    const { user, uid, world } = await setup("avatar-dup");
    const a = await createCharacter(uid, world.id, input("가람", "female-01"));
    const b = await createCharacter(uid, world.id, input("나래", "female-02"));
    expect(a.avatarId).toBe("female-01");
    await expect(createCharacter(uid, world.id, input("다온", "female-01"))).rejects.toMatchObject({ status: 409, code: "AVATAR_IN_USE" });
    await expect(updateCharacter(uid, world.id, b.id, input("나래", "female-01"))).rejects.toMatchObject({ code: "AVATAR_IN_USE" });
    expect((await updateCharacter(uid, world.id, a.id, input("가람2", "female-01"))).changed).toBe(true); // 자기 ID 유지
    expect(await listUsedAvatarIds(uid, world.id, a.id)).toEqual(["female-02"]);

    const other = await createTestWorld(user.id, "다른 세계");
    expect((await createCharacter(uid, other.id, input("가람", "female-01"))).avatarId).toBe("female-01");
  });

  it("사망자는 계속 점유하고, 소프트 삭제된 캐릭터의 일러스트는 다시 쓸 수 있다", async () => {
    const { uid, world } = await setup("avatar-occupy");
    const dead = await createCharacter(uid, world.id, input("도윤", "male-01", "MALE"));
    const gone = await createCharacter(uid, world.id, input("라온", "male-02", "MALE"));
    await prisma.characterCondition.update({ where: { characterId: dead.id }, data: { vital: "DEAD", deathCause: "낙상", deathSceneSeq: 1, diedAt: new Date() } });
    await expect(createCharacter(uid, world.id, input("마루", "male-01", "MALE"))).rejects.toMatchObject({ code: "AVATAR_IN_USE" });
    await deleteCharacter(uid, world.id, gone.id);
    expect((await createCharacter(uid, world.id, input("마루", "male-02", "MALE"))).avatarId).toBe("male-02");
  });

  it("동시 생성·수정이 같은 ID를 요청해도 하나만 성공한다", async () => {
    const { uid, world } = await setup("avatar-race");
    const created = await Promise.allSettled(["바다", "사랑", "아름"].map((n) => createCharacter(uid, world.id, input(n, "female-05"))));
    expect(created.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(created.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(["AVATAR_IN_USE", "AVATAR_IN_USE"]);

    const [x, y] = await Promise.all([createCharacter(uid, world.id, input("자람", "female-06")), createCharacter(uid, world.id, input("차오", "female-07"))]);
    const updated = await Promise.allSettled([updateCharacter(uid, world.id, x.id, input("자람", "female-09")), updateCharacter(uid, world.id, y.id, input("차오", "female-09"))]);
    expect(updated.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.character.count({ where: { worldId: world.id, deletedAt: null, avatarId: "female-09" } })).toBe(1);
  });

  it("저장·불러오기는 avatarId를 복원하고, 기존 NULL 캐릭터는 그대로 NULL이다", async () => {
    const { uid, world } = await setup("avatar-save");
    const a = await createCharacter(uid, world.id, input("하늘", "female-03"));
    const legacy = await prisma.character.create({ data: { worldId: world.id, name: "옛사람", extraversion: 50, agreeableness: 50, conscientiousness: 50, emotionalStability: 50, openness: 50 } });
    const save = await createManualSave(uid, world.id, "일러스트");
    await updateCharacter(uid, world.id, a.id, input("하늘", "female-04"));
    await loadSave(uid, world.id, save.id);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ avatarId: "female-03" });
    expect(await prisma.character.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ avatarId: null });
  });
});
