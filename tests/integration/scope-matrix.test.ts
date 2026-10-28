import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { cleanupTestUsers, createScopeFixture, type ScopeFixture } from "./helpers";

// database.md §4.3의 모든 범위 제약(복합 FK + enforce_same_scope 트리거)이 INSERT와 UPDATE 양쪽에서
// 다른 세계관·다른 사용자 참조를 거부하는지 표로 검증한다.
// DB 카탈로그에 있는 제약이 이 표에 빠지면 커버리지 테스트가 실패한다.

let a: ScopeFixture;
let b: ScopeFixture;
// 세계관 A 안의 정상 행 (UPDATE 대상)
let rowsA: Awaited<ReturnType<typeof seedRowsInA>>;

const rel = { affinity: 0, trust: 0, respect: 0, familiarity: 0 };

async function seedRowsInA() {
  const w = a.world.id;
  const baseline = await prisma.relationshipBaseline.create({ data: { worldId: w, fromCharacterId: a.c1.id, toCharacterId: a.c2.id } });
  const relChange = await prisma.relationshipChange.create({
    data: { worldId: w, relationshipStateId: a.relationship.id, sceneId: a.scene.id, dAffinity: 0, dTrust: 0, dRespect: 0, dFamiliarity: 0, proposed: {} },
  });
  const emotion = await prisma.emotionState.create({ data: { characterId: a.c1.id, worldId: w, mood: "CALM", intensity: 10 } });
  const emoChange = await prisma.emotionChange.create({
    data: { worldId: w, characterId: a.c1.id, sceneId: a.scene.id, fromMood: "NEUTRAL", toMood: "CALM", dIntensity: 1, proposedDelta: 1 },
  });
  await prisma.sceneParticipant.create({ data: { sceneId: a.scene.id, worldId: w, characterId: a.c1.id, alias: "C1", nameSnapshot: "x" } });
  const memory = await prisma.characterMemory.create({
    data: { worldId: w, ownerCharacterId: a.c1.id, aboutCharacterId: a.c2.id, sourceSceneId: a.scene.id, kind: "EVENT", content: "x", importance: 3 },
  });
  const event = await prisma.worldEvent.create({ data: { worldId: w, kind: "SCENE_OUTCOME", title: "t", description: "d", sourceSceneId: a.scene.id } });
  const sse = await prisma.sseConnection.create({ data: { worldId: w, userId: a.user.id, instanceId: "h:1:b" } });
  const log = await prisma.apiRequestLog.create({
    data: { userId: a.user.id, worldId: w, connectionId: a.connection.id, model: "mock", startedAt: new Date(), outcome: "SUCCESS" },
  });
  return { baseline, relChange, emotion, emoChange, memory, event, sse, log };
}

type Case = { constraint: string; insert: () => Promise<unknown>; update: () => Promise<unknown> };

// 모든 경우에 "B 쪽 값"을 넣어 A 세계관 행을 오염시키려 시도한다.
function cases(): Case[] {
  const w = a.world.id;
  const sp = { sceneId_characterId: { sceneId: a.scene.id, characterId: a.c1.id } };
  return [
    // ── 복합 FK
    {
      constraint: "RelationshipBaseline_fromCharacterId_worldId_fkey",
      insert: () => prisma.relationshipBaseline.create({ data: { worldId: w, fromCharacterId: b.c1.id, toCharacterId: a.c1.id } }),
      update: () => prisma.relationshipBaseline.update({ where: { id: rowsA.baseline.id }, data: { fromCharacterId: b.c1.id } }),
    },
    {
      constraint: "RelationshipBaseline_toCharacterId_worldId_fkey",
      insert: () => prisma.relationshipBaseline.create({ data: { worldId: w, fromCharacterId: a.c2.id, toCharacterId: b.c1.id } }),
      update: () => prisma.relationshipBaseline.update({ where: { id: rowsA.baseline.id }, data: { toCharacterId: b.c1.id } }),
    },
    {
      constraint: "RelationshipState_fromCharacterId_worldId_fkey",
      insert: () => prisma.relationshipState.create({ data: { worldId: w, fromCharacterId: b.c1.id, toCharacterId: a.c1.id, ...rel } }),
      update: () => prisma.relationshipState.update({ where: { id: a.relationship.id }, data: { fromCharacterId: b.c1.id } }),
    },
    {
      constraint: "RelationshipState_toCharacterId_worldId_fkey",
      insert: () => prisma.relationshipState.create({ data: { worldId: w, fromCharacterId: a.c2.id, toCharacterId: b.c1.id, ...rel } }),
      update: () => prisma.relationshipState.update({ where: { id: a.relationship.id }, data: { toCharacterId: b.c1.id } }),
    },
    {
      constraint: "RelationshipChange_relationshipStateId_worldId_fkey",
      insert: () =>
        prisma.relationshipChange.create({
          data: { worldId: w, relationshipStateId: b.relationship.id, dAffinity: 0, dTrust: 0, dRespect: 0, dFamiliarity: 0, proposed: {} },
        }),
      update: () => prisma.relationshipChange.update({ where: { id: rowsA.relChange.id }, data: { relationshipStateId: b.relationship.id } }),
    },
    {
      constraint: "EmotionState_characterId_worldId_fkey",
      insert: () => prisma.emotionState.create({ data: { characterId: b.c2.id, worldId: w, mood: "SAD", intensity: 1 } }),
      // characterId는 PK이므로 자기 범위(worldId)를 B로 바꾸는 경로를 검증한다
      update: () => prisma.emotionState.update({ where: { characterId: rowsA.emotion.characterId }, data: { worldId: b.world.id } }),
    },
    {
      constraint: "EmotionChange_characterId_worldId_fkey",
      insert: () =>
        prisma.emotionChange.create({
          data: { worldId: w, characterId: b.c1.id, fromMood: "NEUTRAL", toMood: "SAD", dIntensity: 1, proposedDelta: 1 },
        }),
      update: () => prisma.emotionChange.update({ where: { id: rowsA.emoChange.id }, data: { characterId: b.c1.id } }),
    },
    {
      constraint: "SceneParticipant_sceneId_worldId_fkey",
      insert: () =>
        prisma.sceneParticipant.create({ data: { sceneId: b.scene.id, worldId: w, characterId: a.c2.id, alias: "C2", nameSnapshot: "x" } }),
      update: () => prisma.sceneParticipant.update({ where: sp, data: { sceneId: b.scene.id } }),
    },
    {
      constraint: "SceneParticipant_characterId_worldId_fkey",
      insert: () =>
        prisma.sceneParticipant.create({ data: { sceneId: a.scene.id, worldId: w, characterId: b.c1.id, alias: "C2", nameSnapshot: "x" } }),
      update: () => prisma.sceneParticipant.update({ where: sp, data: { characterId: b.c1.id } }),
    },
    {
      constraint: "Message_sceneId_worldId_fkey",
      insert: () =>
        prisma.message.create({ data: { sceneId: b.scene.id, worldId: w, turnIndex: 5, speakerNameSnapshot: "x", dialogue: "x" } }),
      update: () => prisma.message.update({ where: { id: a.message.id }, data: { sceneId: b.scene.id } }),
    },
    {
      constraint: "CharacterMemory_ownerCharacterId_worldId_fkey",
      insert: () =>
        prisma.characterMemory.create({ data: { worldId: w, ownerCharacterId: b.c1.id, kind: "EVENT", content: "x", importance: 1 } }),
      update: () => prisma.characterMemory.update({ where: { id: rowsA.memory.id }, data: { ownerCharacterId: b.c1.id } }),
    },
    // ── 같은 세계관 트리거
    {
      constraint: "message_speaker_same_world",
      insert: () =>
        prisma.message.create({
          data: { sceneId: a.scene.id, worldId: w, turnIndex: 6, speakerCharacterId: b.c1.id, speakerNameSnapshot: "x", dialogue: "x" },
        }),
      update: () => prisma.message.update({ where: { id: a.message.id }, data: { speakerCharacterId: b.c1.id } }),
    },
    {
      constraint: "memory_about_same_world",
      insert: () =>
        prisma.characterMemory.create({
          data: { worldId: w, ownerCharacterId: a.c1.id, aboutCharacterId: b.c1.id, kind: "IMPRESSION", content: "x", importance: 1 },
        }),
      update: () => prisma.characterMemory.update({ where: { id: rowsA.memory.id }, data: { aboutCharacterId: b.c1.id } }),
    },
    {
      constraint: "memory_source_scene_same_world",
      insert: () =>
        prisma.characterMemory.create({
          data: { worldId: w, ownerCharacterId: a.c1.id, sourceSceneId: b.scene.id, kind: "EVENT", content: "x", importance: 1 },
        }),
      update: () => prisma.characterMemory.update({ where: { id: rowsA.memory.id }, data: { sourceSceneId: b.scene.id } }),
    },
    {
      constraint: "relationship_change_scene_same_world",
      insert: () =>
        prisma.relationshipChange.create({
          data: { worldId: w, relationshipStateId: a.relationship.id, sceneId: b.scene.id, dAffinity: 0, dTrust: 0, dRespect: 0, dFamiliarity: 0, proposed: {} },
        }),
      update: () => prisma.relationshipChange.update({ where: { id: rowsA.relChange.id }, data: { sceneId: b.scene.id } }),
    },
    {
      constraint: "emotion_change_scene_same_world",
      insert: () =>
        prisma.emotionChange.create({
          data: { worldId: w, characterId: a.c1.id, sceneId: b.scene.id, fromMood: "NEUTRAL", toMood: "SAD", dIntensity: 1, proposedDelta: 1 },
        }),
      update: () => prisma.emotionChange.update({ where: { id: rowsA.emoChange.id }, data: { sceneId: b.scene.id } }),
    },
    {
      constraint: "world_event_source_scene_same_world",
      insert: () =>
        prisma.worldEvent.create({ data: { worldId: w, kind: "SCENE_OUTCOME", title: "t", description: "d", sourceSceneId: b.scene.id } }),
      update: () => prisma.worldEvent.update({ where: { id: rowsA.event.id }, data: { sourceSceneId: b.scene.id } }),
    },
    {
      constraint: "scene_run_same_world",
      insert: () =>
        prisma.conversationScene.create({
          data: {
            worldId: w,
            seq: 99,
            attemptId: randomUUID(),
            runId: b.run.id,
            strategyMode: "STORY",
            model: "mock",
            title: "t",
            summary: "s",
            motiveType: "GOAL",
            endReason: "RESOLVED",
          },
        }),
      update: () => prisma.conversationScene.update({ where: { id: a.scene.id }, data: { runId: b.run.id } }),
    },
    {
      constraint: "save_snapshot_same_world",
      insert: () =>
        prisma.saveGame.create({
          data: {
            worldId: w,
            kind: "MANUAL",
            name: "x",
            snapshotId: b.snapshot.id,
            sceneCount: 0,
            characterCount: 0,
            worldNameSnapshot: "x",
            stateVersionAtSave: 0,
          },
        }),
      update: () => prisma.saveGame.update({ where: { recoveryForWorldId: w }, data: { snapshotId: b.snapshot.id } }),
    },
    // ── 같은 사용자 트리거
    {
      constraint: "sse_connection_world_owner",
      insert: () => prisma.sseConnection.create({ data: { worldId: b.world.id, userId: a.user.id, instanceId: "h" } }),
      update: () => prisma.sseConnection.update({ where: { id: rowsA.sse.id }, data: { userId: b.user.id } }),
    },
    {
      constraint: "api_log_world_owner",
      insert: () =>
        prisma.apiRequestLog.create({ data: { userId: a.user.id, worldId: b.world.id, model: "m", startedAt: new Date(), outcome: "SUCCESS" } }),
      update: () => prisma.apiRequestLog.update({ where: { id: rowsA.log.id }, data: { worldId: b.world.id } }),
    },
    {
      constraint: "api_log_connection_owner",
      insert: () =>
        prisma.apiRequestLog.create({
          data: { userId: a.user.id, connectionId: b.connection.id, model: "m", startedAt: new Date(), outcome: "SUCCESS" },
        }),
      update: () => prisma.apiRequestLog.update({ where: { id: rowsA.log.id }, data: { connectionId: b.connection.id } }),
    },
  ];
}

beforeAll(async () => {
  a = await createScopeFixture("MA");
  b = await createScopeFixture("MB");
  rowsA = await seedRowsInA();
});

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("범위 제약 매트릭스 — INSERT·UPDATE", () => {
  // describe 수집 시점에는 fixture가 없으므로 제약 이름만 미리 뽑는다
  const names = [
    "RelationshipBaseline_fromCharacterId_worldId_fkey",
    "RelationshipBaseline_toCharacterId_worldId_fkey",
    "RelationshipState_fromCharacterId_worldId_fkey",
    "RelationshipState_toCharacterId_worldId_fkey",
    "RelationshipChange_relationshipStateId_worldId_fkey",
    "EmotionState_characterId_worldId_fkey",
    "EmotionChange_characterId_worldId_fkey",
    "SceneParticipant_sceneId_worldId_fkey",
    "SceneParticipant_characterId_worldId_fkey",
    "Message_sceneId_worldId_fkey",
    "CharacterMemory_ownerCharacterId_worldId_fkey",
    "message_speaker_same_world",
    "memory_about_same_world",
    "memory_source_scene_same_world",
    "relationship_change_scene_same_world",
    "emotion_change_scene_same_world",
    "world_event_source_scene_same_world",
    "scene_run_same_world",
    "save_snapshot_same_world",
    "sse_connection_world_owner",
    "api_log_world_owner",
    "api_log_connection_owner",
  ];
  const byName = (name: string) => cases().find((c) => c.constraint === name)!;

  for (const name of names) {
    for (const op of ["insert", "update"] as const) {
      it(`${name} — ${op.toUpperCase()} 거부`, async () => {
        await expect(byName(name)[op]()).rejects.toThrow(new RegExp(name));
      });
    }
  }

  it("UPDATE 거부 후 세계관 A의 원래 행은 바뀌지 않았다", async () => {
    expect((await prisma.message.findUniqueOrThrow({ where: { id: a.message.id } })).speakerCharacterId).toBe(a.c1.id);
    expect((await prisma.relationshipState.findUniqueOrThrow({ where: { id: a.relationship.id } })).toCharacterId).toBe(a.c2.id);
    expect((await prisma.saveGame.findUniqueOrThrow({ where: { recoveryForWorldId: a.world.id } })).snapshotId).toBeNull();
    expect((await prisma.characterMemory.findUniqueOrThrow({ where: { id: rowsA.memory.id } })).aboutCharacterId).toBe(a.c2.id);
  });

  it("커버리지: DB의 모든 복합 FK와 enforce_same_scope 트리거가 이 표에 있다", async () => {
    const fks = await prisma.$queryRaw<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND array_length(conkey, 1) = 2`;
    const triggers = await prisma.$queryRaw<{ name: string }[]>`
      SELECT tgname AS name FROM pg_trigger
      WHERE NOT tgisinternal AND tgfoid = 'enforce_same_scope'::regproc`;
    const inCatalog = [...fks, ...triggers].map((r) => r.name).sort();
    expect(inCatalog).toEqual([...names].sort());
    expect(cases().map((c) => c.constraint).sort()).toEqual([...names].sort());
  });
});
