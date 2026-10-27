import { randomUUID } from "node:crypto";
import { prisma } from "@/server/db/client";

// 통합 테스트는 개발 DB를 공유한다. 테스트가 만든 사용자만 지워 정리하고(Cascade), DB 초기화는 하지 않는다.
const createdUserIds = new Set<string>();

export async function createTestUser(label = "user") {
  const id = `test_${label}_${randomUUID()}`;
  createdUserIds.add(id);
  return prisma.user.create({ data: { id, name: label, email: `${id}@example.test` } });
}

/** 세계관 생성 트랜잭션 (database.md §3.6, §6: World + GameState + SimulationRuntime + AUTO SaveGame) */
export async function createTestWorld(ownerId: string, name = "테스트 세계관") {
  return prisma.$transaction(async (tx) => {
    const world = await tx.world.create({ data: { ownerId, name } });
    await tx.gameState.create({ data: { worldId: world.id } });
    await tx.simulationRuntime.create({ data: { worldId: world.id } });
    await tx.saveGame.create({
      data: {
        worldId: world.id,
        kind: "AUTO",
        autoForWorldId: world.id,
        name: "자동저장",
        sceneCount: 0,
        characterCount: 0,
        worldNameSnapshot: name,
        stateVersionAtSave: 0,
      },
    });
    return world;
  });
}

export function characterData(worldId: string, name = "캐릭터") {
  return {
    worldId,
    name,
    extraversion: 50,
    agreeableness: 50,
    conscientiousness: 50,
    emotionalStability: 50,
    openness: 50,
  };
}

export async function cleanupTestUsers() {
  if (createdUserIds.size === 0) return;
  await prisma.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
  createdUserIds.clear();
}
