import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { cleanupTestUsers, createScopeFixture, createTestUser, createTestWorld, type ScopeFixture } from "./helpers";

// database.md §4.3 동일 세계관·동일 사용자 참조 무결성.
// 사용자 A의 세계관 레코드가 사용자 B의 세계관 레코드를 참조하는 경로를 모두 시도해 거부되는지 확인한다.

let a: ScopeFixture;
let b: ScopeFixture;

beforeAll(async () => {
  a = await createScopeFixture("A");
  b = await createScopeFixture("B");
});

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

const rel = { affinity: 0, trust: 0, respect: 0, familiarity: 0 };

describe("필수 참조 — (id, worldId) 복합 FK", () => {
  it("RelationshipBaseline: 다른 세계관 캐릭터를 대상으로 지정할 수 없다", async () => {
    await expect(
      prisma.relationshipBaseline.create({ data: { worldId: a.world.id, fromCharacterId: a.c1.id, toCharacterId: b.c1.id } }),
    ).rejects.toThrow(/RelationshipBaseline_toCharacterId_worldId_fkey/);
  });

  it("RelationshipState: 다른 세계관 캐릭터와 관계를 만들 수 없다", async () => {
    await expect(
      prisma.relationshipState.create({ data: { worldId: a.world.id, fromCharacterId: a.c1.id, toCharacterId: b.c1.id, ...rel } }),
    ).rejects.toThrow(/RelationshipState_toCharacterId_worldId_fkey/);
  });

  it("RelationshipState: 다른 세계관 캐릭터끼리의 관계를 내 세계관에 넣을 수 없다", async () => {
    await expect(
      prisma.relationshipState.create({ data: { worldId: a.world.id, fromCharacterId: b.c2.id, toCharacterId: b.c1.id, ...rel } }),
    ).rejects.toThrow(/RelationshipState_(from|to)CharacterId_worldId_fkey/);
  });

  it("RelationshipChange: 다른 세계관 관계의 변화 이력을 만들 수 없다", async () => {
    await expect(
      prisma.relationshipChange.create({
        data: { worldId: a.world.id, relationshipStateId: b.relationship.id, dAffinity: 1, dTrust: 0, dRespect: 0, dFamiliarity: 0, proposed: {} },
      }),
    ).rejects.toThrow(/RelationshipChange_relationshipStateId_worldId_fkey/);
  });

  it("EmotionState·EmotionChange: 다른 세계관 캐릭터의 감정을 만들 수 없다", async () => {
    await expect(
      prisma.emotionState.create({ data: { characterId: b.c1.id, worldId: a.world.id, mood: "HAPPY", intensity: 50 } }),
    ).rejects.toThrow(/EmotionState_characterId_worldId_fkey/);
    await expect(
      prisma.emotionChange.create({
        data: { worldId: a.world.id, characterId: b.c1.id, fromMood: "NEUTRAL", toMood: "HAPPY", dIntensity: 5, proposedDelta: 5 },
      }),
    ).rejects.toThrow(/EmotionChange_characterId_worldId_fkey/);
  });

  it("SceneParticipant: 다른 세계관 캐릭터를 장면 참가자로 넣거나 다른 세계관 장면에 참가시킬 수 없다", async () => {
    await expect(
      prisma.sceneParticipant.create({
        data: { sceneId: a.scene.id, worldId: a.world.id, characterId: b.c1.id, alias: "C1", nameSnapshot: "x" },
      }),
    ).rejects.toThrow(/SceneParticipant_characterId_worldId_fkey/);
    await expect(
      prisma.sceneParticipant.create({
        data: { sceneId: b.scene.id, worldId: a.world.id, characterId: a.c1.id, alias: "C1", nameSnapshot: "x" },
      }),
    ).rejects.toThrow(/SceneParticipant_sceneId_worldId_fkey/);
  });

  it("Message: 다른 세계관 장면에 메시지를 넣을 수 없다", async () => {
    await expect(
      prisma.message.create({ data: { sceneId: b.scene.id, worldId: a.world.id, turnIndex: 9, speakerNameSnapshot: "x", dialogue: "x" } }),
    ).rejects.toThrow(/Message_sceneId_worldId_fkey/);
  });

  it("CharacterMemory: 다른 세계관 캐릭터를 기억 소유자로 지정할 수 없다", async () => {
    await expect(
      prisma.characterMemory.create({ data: { worldId: a.world.id, ownerCharacterId: b.c1.id, kind: "SECRET", content: "x", importance: 3 } }),
    ).rejects.toThrow(/CharacterMemory_ownerCharacterId_worldId_fkey/);
  });

  it("참조 중인 캐릭터의 worldId를 다른 세계관으로 옮길 수 없다 (ON UPDATE RESTRICT)", async () => {
    await expect(prisma.character.update({ where: { id: a.c1.id }, data: { worldId: b.world.id } })).rejects.toThrow(
      /_worldId_fkey/,
    );
    expect((await prisma.character.findUniqueOrThrow({ where: { id: a.c1.id } })).worldId).toBe(a.world.id);
  });
});

describe("nullable·SetNull 참조 — 동일 세계관 트리거", () => {
  it("Message.speakerCharacterId: 생성·수정 모두 다른 세계관 캐릭터를 거부한다", async () => {
    await expect(
      prisma.message.create({
        data: { sceneId: a.scene.id, worldId: a.world.id, turnIndex: 1, speakerCharacterId: b.c1.id, speakerNameSnapshot: "x", dialogue: "x" },
      }),
    ).rejects.toThrow(/message_speaker_same_world/);
    await expect(
      prisma.message.update({ where: { id: a.message.id }, data: { speakerCharacterId: b.c1.id } }),
    ).rejects.toThrow(/message_speaker_same_world/);
  });

  it("CharacterMemory.aboutCharacterId·sourceSceneId", async () => {
    const base = { worldId: a.world.id, ownerCharacterId: a.c1.id, kind: "IMPRESSION" as const, content: "x", importance: 2 };
    await expect(prisma.characterMemory.create({ data: { ...base, aboutCharacterId: b.c1.id } })).rejects.toThrow(
      /memory_about_same_world/,
    );
    await expect(prisma.characterMemory.create({ data: { ...base, sourceSceneId: b.scene.id } })).rejects.toThrow(
      /memory_source_scene_same_world/,
    );
  });

  it("RelationshipChange·EmotionChange·WorldEvent의 장면 참조", async () => {
    await expect(
      prisma.relationshipChange.create({
        data: { worldId: a.world.id, relationshipStateId: a.relationship.id, sceneId: b.scene.id, dAffinity: 1, dTrust: 0, dRespect: 0, dFamiliarity: 0, proposed: {} },
      }),
    ).rejects.toThrow(/relationship_change_scene_same_world/);
    await expect(
      prisma.emotionChange.create({
        data: { worldId: a.world.id, characterId: a.c1.id, sceneId: b.scene.id, fromMood: "NEUTRAL", toMood: "SAD", dIntensity: 1, proposedDelta: 1 },
      }),
    ).rejects.toThrow(/emotion_change_scene_same_world/);
    await expect(
      prisma.worldEvent.create({ data: { worldId: a.world.id, kind: "SCENE_OUTCOME", title: "t", description: "d", sourceSceneId: b.scene.id } }),
    ).rejects.toThrow(/world_event_source_scene_same_world/);
  });

  it("ConversationScene.runId: 다른 세계관 Run으로 장면을 기록할 수 없다", async () => {
    await expect(prisma.conversationScene.update({ where: { id: a.scene.id }, data: { runId: b.run.id } })).rejects.toThrow(
      /scene_run_same_world/,
    );
  });

  it("SaveGame.snapshotId: 다른 사용자 세계관의 스냅샷을 세이브로 연결할 수 없다", async () => {
    await expect(
      prisma.saveGame.create({
        data: {
          worldId: a.world.id,
          kind: "MANUAL",
          name: "탈취",
          snapshotId: b.snapshot.id,
          sceneCount: 0,
          characterCount: 0,
          worldNameSnapshot: "x",
          stateVersionAtSave: 0,
        },
      }),
    ).rejects.toThrow(/save_snapshot_same_world/);
    await expect(
      prisma.saveGame.update({ where: { recoveryForWorldId: a.world.id }, data: { snapshotId: b.snapshot.id } }),
    ).rejects.toThrow(/save_snapshot_same_world/);
  });
});

describe("사용자 범위 참조 — 소유자 일치 트리거", () => {
  it("SseConnection.userId는 세계관 소유자여야 한다", async () => {
    await expect(
      prisma.sseConnection.create({ data: { worldId: a.world.id, userId: b.user.id, instanceId: "host:1:boot" } }),
    ).rejects.toThrow(/sse_connection_world_owner/);
  });

  it("ApiRequestLog는 자기 세계관·자기 키 연결만 참조한다", async () => {
    const log = { userId: a.user.id, model: "mock", startedAt: new Date(), outcome: "SUCCESS" as const };
    await expect(prisma.apiRequestLog.create({ data: { ...log, worldId: b.world.id } })).rejects.toThrow(
      /api_log_world_owner/,
    );
    await expect(prisma.apiRequestLog.create({ data: { ...log, connectionId: b.connection.id } })).rejects.toThrow(
      /api_log_connection_owner/,
    );
  });

  it("같은 사용자 범위의 정상 참조는 허용한다", async () => {
    await prisma.sseConnection.create({ data: { worldId: a.world.id, userId: a.user.id, instanceId: "host:1:boot" } });
    await prisma.apiRequestLog.create({
      data: { userId: a.user.id, worldId: a.world.id, connectionId: a.connection.id, model: "mock", startedAt: new Date(), outcome: "SUCCESS" },
    });
  });
});

describe("SseConnection.userId FK", () => {
  it("사용자를 삭제하면 그 사용자의 SSE 연결 행이 함께 삭제된다", async () => {
    const user = await createTestUser("sse");
    const world = await createTestWorld(user.id);
    const conn = await prisma.sseConnection.create({ data: { worldId: world.id, userId: user.id, instanceId: "host:1:boot" } });

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.sseConnection.findUnique({ where: { id: conn.id } })).toBeNull();
  });

  it("존재하지 않는 사용자로 SSE 연결을 등록할 수 없다", async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "SseConnection" (id, "worldId", "userId", "instanceId") VALUES (${randomUUID()}, ${a.world.id}, 'missing-user', 'h')`,
    ).rejects.toThrow(/SseConnection_userId_fkey|sse_connection_world_owner/);
  });
});
