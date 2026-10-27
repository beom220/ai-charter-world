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

/** 범위 무결성 테스트용: 사용자 1명 + 세계관 1개와 주요 하위 레코드 (database.md §4.3) */
export async function createScopeFixture(label: string) {
  const user = await createTestUser(label);
  const world = await createTestWorld(user.id, `${label} 세계관`);
  const c1 = await prisma.character.create({ data: characterData(world.id, `${label}-1`) });
  const c2 = await prisma.character.create({ data: characterData(world.id, `${label}-2`) });
  const run = await prisma.simulationRun.create({ data: { worldId: world.id } });
  const scene = await prisma.conversationScene.create({
    data: {
      worldId: world.id,
      seq: 1,
      attemptId: randomUUID(),
      runId: run.id,
      strategyMode: "STORY",
      model: "mock",
      title: "장면",
      summary: "요약",
      motiveType: "GOAL",
      endReason: "RESOLVED",
    },
  });
  const message = await prisma.message.create({
    data: { sceneId: scene.id, worldId: world.id, turnIndex: 0, speakerCharacterId: c1.id, speakerNameSnapshot: c1.name, dialogue: "x" },
  });
  const relationship = await prisma.relationshipState.create({
    data: { worldId: world.id, fromCharacterId: c1.id, toCharacterId: c2.id, affinity: 0, trust: 0, respect: 0, familiarity: 0 },
  });
  const snapshot = await prisma.gameSnapshot.create({
    data: { worldId: world.id, schemaVersion: 1, payload: { schemaVersion: 1 }, sizeBytes: 17, checksum: "0".repeat(64) },
  });
  const connection = await prisma.aiProviderConnection.create({
    data: {
      userId: user.id,
      encryptedKey: Buffer.from("c"),
      keyIv: Buffer.from("i"),
      keyAuthTag: Buffer.from("t"),
      encryptionKeyVersion: 1,
      keyLast4: "abcd",
      keyFingerprint: "fp",
      defaultModel: "mock-model",
    },
  });
  return { user, world, c1, c2, run, scene, message, relationship, snapshot, connection };
}

export type ScopeFixture = Awaited<ReturnType<typeof createScopeFixture>>;

export async function cleanupTestUsers() {
  if (createdUserIds.size === 0) return;
  await prisma.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
  createdUserIds.clear();
}
