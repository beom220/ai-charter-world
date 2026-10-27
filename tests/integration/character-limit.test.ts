import { afterAll, describe, expect, it } from "vitest";
import { MAX_ACTIVE_CHARACTERS_PER_WORLD } from "../../config/limits";
import { prisma } from "@/server/db/client";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld } from "./helpers";

// database.md §6.6 캐릭터 생성 패턴을 검증한다.
// 6명 상한은 앱에서 강제하며, World 행 FOR UPDATE로 같은 세계관의 생성 요청을 직렬화한다.
// 실제 도메인 서비스는 캐릭터 기능 단계에서 구현하고, 여기서는 잠금 패턴 자체를 검증한다.

class CharacterLimitError extends Error {}

async function createCharacterWithLimit(worldId: string, name: string) {
  return prisma.$transaction(async (tx) => {
    // 잠금 순서: World → GameState
    await tx.$queryRaw`SELECT 1 FROM "World" WHERE id = ${worldId} FOR UPDATE`;
    await tx.$executeRaw`UPDATE "GameState" SET "changeSeq" = "changeSeq" + 1 WHERE "worldId" = ${worldId}`;
    const active = await tx.character.count({ where: { worldId, deletedAt: null } });
    if (active >= MAX_ACTIVE_CHARACTERS_PER_WORLD) {
      throw new CharacterLimitError(`활성 캐릭터는 최대 ${MAX_ACTIVE_CHARACTERS_PER_WORLD}명입니다.`);
    }
    const character = await tx.character.create({ data: characterData(worldId, name) });
    await tx.emotionState.create({
      data: { characterId: character.id, worldId, mood: character.initialMood, intensity: character.initialMoodIntensity },
    });
    return character;
  });
}

async function newWorld(existing: number) {
  const user = await createTestUser("limit");
  const world = await createTestWorld(user.id);
  for (let i = 0; i < existing; i++) {
    await prisma.character.create({ data: characterData(world.id, `기존${i + 1}`) });
  }
  return world;
}

const activeCount = (worldId: string) => prisma.character.count({ where: { worldId, deletedAt: null } });

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("세계관당 활성 캐릭터 최대 6명 — 동시성", () => {
  it("동시에 8건을 생성해도 활성 캐릭터는 정확히 6명이고 나머지는 거부된다", async () => {
    const world = await newWorld(4);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => createCharacterWithLimit(world.id, `동시${i + 1}`)),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(6);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(CharacterLimitError);
    expect(await activeCount(world.id)).toBe(MAX_ACTIVE_CHARACTERS_PER_WORLD);
    expect(await prisma.emotionState.count({ where: { worldId: world.id } })).toBe(2);
    // 성공한 생성만 changeSeq를 올린다 (거부된 트랜잭션은 롤백)
    expect((await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } })).changeSeq).toBe(2);
  });

  it("소프트 삭제된 캐릭터는 상한에 포함되지 않는다", async () => {
    const world = await newWorld(6);
    await expect(createCharacterWithLimit(world.id, "7번째")).rejects.toBeInstanceOf(CharacterLimitError);

    const victim = await prisma.character.findFirstOrThrow({ where: { worldId: world.id } });
    await prisma.character.update({ where: { id: victim.id }, data: { deletedAt: new Date() } });

    await createCharacterWithLimit(world.id, "대체");
    expect(await activeCount(world.id)).toBe(6);
    expect(await prisma.character.count({ where: { worldId: world.id } })).toBe(7);
  });

  it("다른 세계관의 생성은 서로 막지 않는다", async () => {
    const [w1, w2] = await Promise.all([newWorld(5), newWorld(5)]);
    await Promise.all([createCharacterWithLimit(w1.id, "a"), createCharacterWithLimit(w2.id, "b")]);
    expect([await activeCount(w1.id), await activeCount(w2.id)]).toEqual([6, 6]);
  });

  it("대조: World 잠금 없이 count→insert 하면 경쟁 조건으로 7명이 된다", async () => {
    const world = await newWorld(5);

    // 두 트랜잭션이 모두 count를 마친 뒤에 insert하도록 맞춘다.
    let arrived = 0;
    let release!: () => void;
    const bothCounted = new Promise<void>((resolve) => (release = resolve));

    const unsafeCreate = (name: string) =>
      prisma.$transaction(async (tx) => {
        const active = await tx.character.count({ where: { worldId: world.id, deletedAt: null } });
        if (++arrived === 2) release();
        await bothCounted;
        if (active >= MAX_ACTIVE_CHARACTERS_PER_WORLD) throw new CharacterLimitError("limit");
        return tx.character.create({ data: characterData(world.id, name) });
      });

    await Promise.all([unsafeCreate("경쟁1"), unsafeCreate("경쟁2")]);
    expect(await activeCount(world.id)).toBe(MAX_ACTIVE_CHARACTERS_PER_WORLD + 1);
  });
});
