import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld } from "./helpers";

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

async function createWorldWithCharacters(count: number) {
  const user = await createTestUser();
  const world = await createTestWorld(user.id);
  const characters = [];
  for (let i = 0; i < count; i++) {
    characters.push(await prisma.character.create({ data: characterData(world.id, `캐릭터${i + 1}`) }));
  }
  return { user, world, characters };
}

function sceneData(worldId: string, seq: number, attemptId: string = randomUUID()) {
  return {
    worldId,
    seq,
    attemptId,
    strategyMode: "STORY" as const,
    model: "mock",
    title: `장면 ${seq}`,
    summary: "요약",
    motiveType: "GOAL" as const,
    endReason: "RESOLVED" as const,
  };
}

function snapshotData(worldId: string) {
  return { worldId, schemaVersion: 1, payload: { schemaVersion: 1 }, sizeBytes: 17, checksum: "0".repeat(64) };
}

describe("DB 스키마 상태", () => {
  it("모든 DateTime 컬럼이 timestamptz다 (database.md §1-9)", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`;
    expect(rows).toEqual([]);
  });

  it("database.md §4.1 CHECK 제약 10개가 모두 있다", async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = 'c' ORDER BY c.conname`;
    expect(rows.map((r) => r.conname)).toEqual([
      "baseline_not_self",
      "baseline_range",
      "character_age_range",
      "character_bigfive_range",
      "emotion_range",
      "gs_turns",
      "memory_importance",
      "rel_not_self",
      "rel_range",
      "save_kind_consistency",
    ]);
  });
});

describe("외래 키", () => {
  it("존재하지 않는 소유자로 세계관을 만들 수 없다", async () => {
    await expect(prisma.world.create({ data: { ownerId: "missing", name: "w" } })).rejects.toThrow(
      /World_ownerId_fkey/,
    );
  });

  it("존재하지 않는 세계관에 캐릭터를 만들 수 없다", async () => {
    await expect(prisma.character.create({ data: characterData("missing") })).rejects.toThrow(
      /Character_worldId_fkey/,
    );
  });

  it("존재하지 않는 장면에 메시지를 만들 수 없다", async () => {
    const { world } = await createWorldWithCharacters(0);
    await expect(
      prisma.message.create({
        data: { sceneId: "missing", worldId: world.id, turnIndex: 0, speakerNameSnapshot: "x", dialogue: "x" },
      }),
    ).rejects.toThrow(/Message_sceneId_worldId_fkey/);
  });
});

describe("UNIQUE 제약", () => {
  it("Better Auth: user.email, session.token", async () => {
    const user = await createTestUser();
    await expect(
      prisma.user.create({ data: { id: `${user.id}_dup`, name: "dup", email: user.email } }),
    ).rejects.toThrow(/user_email_key/);

    const session = { userId: user.id, token: `tok_${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) };
    await prisma.session.create({ data: { id: randomUUID(), ...session } });
    await expect(prisma.session.create({ data: { id: randomUUID(), ...session } })).rejects.toThrow(
      /session_token_key/,
    );
  });

  it("사용자당 Provider별 연결은 1개다 (같은 사용자·같은 Provider 중복 거부)", async () => {
    const user = await createTestUser();
    const conn = {
      userId: user.id,
      encryptedKey: Buffer.from("ciphertext"),
      keyIv: Buffer.from("iv"),
      keyAuthTag: Buffer.from("tag"),
      encryptionKeyVersion: 1,
      keyLast4: "abcd",
      keyFingerprint: "fp",
      defaultModel: "mock-model",
    };
    await prisma.aiProviderConnection.create({ data: conn });
    await expect(prisma.aiProviderConnection.create({ data: { ...conn, provider: "GEMINI" } })).rejects.toThrow(
      /AiProviderConnection_userId_provider_key/,
    );

    // User ↔ AiProviderConnection은 1:N 관계다 (Provider 추가 시 행이 늘어난다)
    const withConnections = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { providerConnections: true },
    });
    expect(withConnections.providerConnections.map((c) => c.provider)).toEqual(["GEMINI"]);

    // 다른 사용자는 같은 Provider 연결을 따로 가진다
    const other = await createTestUser("other");
    await prisma.aiProviderConnection.create({ data: { ...conn, userId: other.id } });
  });

  it("(userId, provider) UNIQUE 외에 userId 단독 UNIQUE가 남아 있지 않다", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'AiProviderConnection' AND indexdef LIKE 'CREATE UNIQUE%'`;
    expect(rows.map((r) => r.indexdef).sort()).toEqual([
      expect.stringContaining('"AiProviderConnection_pkey" ON public."AiProviderConnection" USING btree (id)'),
      expect.stringContaining('("userId", provider)'),
    ]);
  });

  it("세계관당 GameState·복구 지점(RECOVERY)은 1개다", async () => {
    const { world } = await createWorldWithCharacters(0);
    await expect(prisma.gameState.create({ data: { worldId: world.id } })).rejects.toThrow(/GameState_pkey/);
    await expect(
      prisma.saveGame.create({
        data: {
          worldId: world.id,
          kind: "RECOVERY",
          recoveryForWorldId: world.id,
          name: "자동저장",
          sceneCount: 0,
          characterCount: 0,
          worldNameSnapshot: world.name,
          stateVersionAtSave: 0,
        },
      }),
    ).rejects.toThrow(/SaveGame_recoveryForWorldId_key/);
  });

  it("장면 attemptId는 전역 유일하다 (멱등 커밋)", async () => {
    const { world } = await createWorldWithCharacters(0);
    const attemptId = randomUUID();
    await prisma.conversationScene.create({ data: sceneData(world.id, 1, attemptId) });
    await expect(prisma.conversationScene.create({ data: sceneData(world.id, 2, attemptId) })).rejects.toThrow(
      /ConversationScene_attemptId_key/,
    );
  });

  it("장면 seq는 세계관 안에서 유일하고, 메시지 turnIndex는 장면 안에서 유일하다", async () => {
    const { world, characters } = await createWorldWithCharacters(1);
    const scene = await prisma.conversationScene.create({ data: sceneData(world.id, 1) });
    await expect(prisma.conversationScene.create({ data: sceneData(world.id, 1) })).rejects.toThrow(
      /ConversationScene_worldId_seq_key/,
    );

    const message = {
      sceneId: scene.id,
      worldId: world.id,
      turnIndex: 0,
      speakerCharacterId: characters[0]!.id,
      speakerNameSnapshot: characters[0]!.name,
      dialogue: "안녕",
    };
    await prisma.message.create({ data: message });
    await expect(prisma.message.create({ data: message })).rejects.toThrow(/Message_sceneId_turnIndex_key/);
  });

  it("관계는 방향성이 있다: A→B 중복은 거부, B→A는 별도 행", async () => {
    const { world, characters } = await createWorldWithCharacters(2);
    const [a, b] = characters as [(typeof characters)[0], (typeof characters)[0]];
    const rel = { worldId: world.id, affinity: 0, trust: 0, respect: 0, familiarity: 0 };
    await prisma.relationshipState.create({ data: { ...rel, fromCharacterId: a.id, toCharacterId: b.id } });
    await prisma.relationshipState.create({ data: { ...rel, fromCharacterId: b.id, toCharacterId: a.id } });
    await expect(
      prisma.relationshipState.create({ data: { ...rel, fromCharacterId: a.id, toCharacterId: b.id } }),
    ).rejects.toThrow(/RelationshipState_fromCharacterId_toCharacterId_key/);

    await prisma.relationshipBaseline.create({ data: { worldId: world.id, fromCharacterId: a.id, toCharacterId: b.id } });
    await expect(
      prisma.relationshipBaseline.create({ data: { worldId: world.id, fromCharacterId: a.id, toCharacterId: b.id } }),
    ).rejects.toThrow(/RelationshipBaseline_fromCharacterId_toCharacterId_key/);
  });

  it("스냅샷 하나는 세이브 하나만 참조한다", async () => {
    const { world } = await createWorldWithCharacters(0);
    const snapshot = await prisma.gameSnapshot.create({ data: snapshotData(world.id) });
    const manual = {
      worldId: world.id,
      kind: "MANUAL" as const,
      name: "슬롯",
      snapshotId: snapshot.id,
      sceneCount: 0,
      characterCount: 0,
      worldNameSnapshot: world.name,
      stateVersionAtSave: 0,
    };
    await prisma.saveGame.create({ data: manual });
    await expect(prisma.saveGame.create({ data: manual })).rejects.toThrow(/SaveGame_snapshotId_key/);
  });
});

describe("CHECK 제약 (database.md §4.1)", () => {
  let worldId: string;
  let aId: string;
  let bId: string;

  beforeAll(async () => {
    const { world, characters } = await createWorldWithCharacters(2);
    worldId = world.id;
    aId = characters[0]!.id;
    bId = characters[1]!.id;
  });

  it("Big Five·초기 감정 강도 0..100, 나이 0..1000", async () => {
    await expect(prisma.character.create({ data: { ...characterData(worldId), openness: 101 } })).rejects.toThrow(
      /character_bigfive_range/,
    );
    await expect(
      prisma.character.create({ data: { ...characterData(worldId), initialMoodIntensity: -1 } }),
    ).rejects.toThrow(/character_bigfive_range/);
    await expect(prisma.character.create({ data: { ...characterData(worldId), age: 1001 } })).rejects.toThrow(
      /character_age_range/,
    );
  });

  it("관계 범위(호감·신뢰·존경 −100..100, 친밀 0..100)와 자기 자신 금지", async () => {
    const base = { worldId, affinity: 0, trust: 0, respect: 0, familiarity: 0 };
    await expect(
      prisma.relationshipState.create({ data: { ...base, fromCharacterId: aId, toCharacterId: bId, trust: -101 } }),
    ).rejects.toThrow(/rel_range/);
    await expect(
      prisma.relationshipState.create({ data: { ...base, fromCharacterId: aId, toCharacterId: bId, familiarity: -1 } }),
    ).rejects.toThrow(/rel_range/);
    await expect(
      prisma.relationshipState.create({ data: { ...base, fromCharacterId: aId, toCharacterId: aId } }),
    ).rejects.toThrow(/rel_not_self/);
    await expect(
      prisma.relationshipBaseline.create({ data: { worldId, fromCharacterId: aId, toCharacterId: bId, affinity: 101 } }),
    ).rejects.toThrow(/baseline_range/);
    await expect(
      prisma.relationshipBaseline.create({ data: { worldId, fromCharacterId: aId, toCharacterId: aId } }),
    ).rejects.toThrow(/baseline_not_self/);
  });

  it("경계값은 허용한다", async () => {
    await prisma.relationshipState.create({
      data: { worldId, fromCharacterId: bId, toCharacterId: aId, affinity: -100, trust: 100, respect: -100, familiarity: 100 },
    });
    await prisma.emotionState.create({ data: { characterId: aId, worldId, mood: "CALM", intensity: 100 } });
  });

  it("감정 강도 0..100, 기억 중요도 1..5", async () => {
    await expect(
      prisma.emotionState.create({ data: { characterId: bId, worldId, mood: "SAD", intensity: 101 } }),
    ).rejects.toThrow(/emotion_range/);
    await expect(
      prisma.characterMemory.create({
        data: { worldId, ownerCharacterId: aId, kind: "EVENT", content: "x", importance: 6 },
      }),
    ).rejects.toThrow(/memory_importance/);
  });

  it("실행 설정: 턴 3..6, 참가자 2 ≤ min ≤ max ≤ 6", async () => {
    await expect(prisma.gameState.update({ where: { worldId }, data: { maxTurnsPerScene: 7 } })).rejects.toThrow(
      /gs_turns/,
    );
    await expect(
      prisma.gameState.update({ where: { worldId }, data: { participantsMin: 4, participantsMax: 3 } }),
    ).rejects.toThrow(/gs_turns/);
    await expect(prisma.gameState.update({ where: { worldId }, data: { participantsMin: 1 } })).rejects.toThrow(
      /gs_turns/,
    );
  });

  it("세이브 종류 일관성: MANUAL은 스냅샷 필수, RECOVERY는 recoveryForWorldId = worldId", async () => {
    const meta = { name: "s", sceneCount: 0, characterCount: 0, worldNameSnapshot: "w", stateVersionAtSave: 0 };
    await expect(prisma.saveGame.create({ data: { worldId, kind: "MANUAL", ...meta } })).rejects.toThrow(
      /save_kind_consistency/,
    );
    const other = await createWorldWithCharacters(0);
    await expect(
      prisma.saveGame.create({ data: { worldId, kind: "RECOVERY", recoveryForWorldId: other.world.id, ...meta } }),
    ).rejects.toThrow(/save_kind_consistency/);
  });
});

describe("삭제 정책 (database.md §7)", () => {
  it("세계관 삭제 시 하위 데이터가 모두 연쇄 삭제된다", async () => {
    const { world, characters } = await createWorldWithCharacters(2);
    const [a, b] = characters as [(typeof characters)[0], (typeof characters)[0]];
    const scene = await prisma.conversationScene.create({ data: sceneData(world.id, 1) });
    await prisma.sceneParticipant.create({ data: { sceneId: scene.id, worldId: world.id, characterId: a.id, alias: "C1", nameSnapshot: a.name } });
    await prisma.message.create({
      data: { sceneId: scene.id, worldId: world.id, turnIndex: 0, speakerCharacterId: a.id, speakerNameSnapshot: a.name, dialogue: "x" },
    });
    await prisma.relationshipState.create({
      data: { worldId: world.id, fromCharacterId: a.id, toCharacterId: b.id, affinity: 0, trust: 0, respect: 0, familiarity: 0 },
    });
    await prisma.characterMemory.create({ data: { worldId: world.id, ownerCharacterId: a.id, kind: "EVENT", content: "x", importance: 3 } });
    await prisma.gameSnapshot.create({ data: snapshotData(world.id) });
    await prisma.simulationEvent.create({ data: { worldId: world.id, type: "runtime.status", payload: {} } });
    await prisma.systemNotice.create({ data: { worldId: world.id, code: "NETWORK_ERROR", message: "x" } });

    await prisma.world.delete({ where: { id: world.id } });

    const where = { worldId: world.id };
    const counts = await Promise.all([
      prisma.gameState.count({ where }),
      prisma.simulationRuntime.count({ where }),
      prisma.saveGame.count({ where }),
      prisma.gameSnapshot.count({ where }),
      prisma.character.count({ where }),
      prisma.conversationScene.count({ where }),
      prisma.sceneParticipant.count({ where: { sceneId: scene.id } }),
      prisma.message.count({ where }),
      prisma.relationshipState.count({ where }),
      prisma.characterMemory.count({ where }),
      prisma.simulationEvent.count({ where }),
      prisma.systemNotice.count({ where }),
    ]);
    expect(counts).toEqual(counts.map(() => 0));
  });

  it("사용자 삭제 시 세션·계정·연결·사용량·세계관·로그가 연쇄 삭제된다", async () => {
    const user = await createTestUser();
    const world = await createTestWorld(user.id);
    await prisma.session.create({
      data: { id: randomUUID(), userId: user.id, token: `tok_${randomUUID()}`, expiresAt: new Date() },
    });
    await prisma.account.create({ data: { id: randomUUID(), userId: user.id, accountId: "google-sub", providerId: "google" } });
    const conn = await prisma.aiProviderConnection.create({
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
    await prisma.apiUsageDaily.create({ data: { connectionId: conn.id, usageDate: new Date("2026-10-27") } });
    await prisma.apiRequestLog.create({
      data: { userId: user.id, connectionId: conn.id, worldId: world.id, model: "mock", startedAt: new Date(), outcome: "SUCCESS" },
    });

    await prisma.user.delete({ where: { id: user.id } });

    const counts = await Promise.all([
      prisma.session.count({ where: { userId: user.id } }),
      prisma.account.count({ where: { userId: user.id } }),
      prisma.aiProviderConnection.count({ where: { userId: user.id } }),
      prisma.apiUsageDaily.count({ where: { connectionId: conn.id } }),
      prisma.world.count({ where: { ownerId: user.id } }),
      prisma.apiRequestLog.count({ where: { userId: user.id } }),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("대화 기록(장면) 삭제는 메시지만 지우고 기억·관계·감정 이력은 scene 참조만 NULL로 남긴다 (D9)", async () => {
    const { world, characters } = await createWorldWithCharacters(2);
    const [a, b] = characters as [(typeof characters)[0], (typeof characters)[0]];
    const scene = await prisma.conversationScene.create({ data: sceneData(world.id, 1) });
    await prisma.message.create({
      data: { sceneId: scene.id, worldId: world.id, turnIndex: 0, speakerCharacterId: a.id, speakerNameSnapshot: a.name, dialogue: "x" },
    });
    const memory = await prisma.characterMemory.create({
      data: { worldId: world.id, ownerCharacterId: a.id, kind: "PROMISE", content: "약속", importance: 4, sourceSceneId: scene.id },
    });
    const rel = await prisma.relationshipState.create({
      data: { worldId: world.id, fromCharacterId: a.id, toCharacterId: b.id, affinity: 3, trust: 0, respect: 0, familiarity: 1 },
    });
    const relChange = await prisma.relationshipChange.create({
      data: { worldId: world.id, relationshipStateId: rel.id, sceneId: scene.id, dAffinity: 3, dTrust: 0, dRespect: 0, dFamiliarity: 1, proposed: { affinity: 9 }, clamped: true },
    });
    const emoChange = await prisma.emotionChange.create({
      data: { worldId: world.id, characterId: a.id, sceneId: scene.id, fromMood: "NEUTRAL", toMood: "HAPPY", dIntensity: 10, proposedDelta: 10 },
    });
    const event = await prisma.worldEvent.create({
      data: { worldId: world.id, kind: "SCENE_OUTCOME", title: "e", description: "d", sourceSceneId: scene.id },
    });

    await prisma.conversationScene.delete({ where: { id: scene.id } });

    expect(await prisma.message.count({ where: { sceneId: scene.id } })).toBe(0);
    expect((await prisma.characterMemory.findUniqueOrThrow({ where: { id: memory.id } })).sourceSceneId).toBeNull();
    expect((await prisma.relationshipChange.findUniqueOrThrow({ where: { id: relChange.id } })).sceneId).toBeNull();
    expect((await prisma.emotionChange.findUniqueOrThrow({ where: { id: emoChange.id } })).sceneId).toBeNull();
    expect((await prisma.worldEvent.findUniqueOrThrow({ where: { id: event.id } })).sourceSceneId).toBeNull();
    expect((await prisma.relationshipState.findUniqueOrThrow({ where: { id: rel.id } })).affinity).toBe(3);
  });

  it("캐릭터를 실제 삭제하면 메시지 화자는 NULL, 이름 스냅샷은 유지된다", async () => {
    const { world, characters } = await createWorldWithCharacters(2);
    const [a, b] = characters as [(typeof characters)[0], (typeof characters)[0]];
    const scene = await prisma.conversationScene.create({ data: sceneData(world.id, 1) });
    const message = await prisma.message.create({
      data: { sceneId: scene.id, worldId: world.id, turnIndex: 0, speakerCharacterId: a.id, speakerNameSnapshot: a.name, dialogue: "x" },
    });
    const memory = await prisma.characterMemory.create({
      data: { worldId: world.id, ownerCharacterId: b.id, aboutCharacterId: a.id, kind: "IMPRESSION", content: "인상", importance: 2 },
    });

    await prisma.character.delete({ where: { id: a.id } });

    const after = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(after.speakerCharacterId).toBeNull();
    expect(after.speakerNameSnapshot).toBe(a.name);
    expect((await prisma.characterMemory.findUniqueOrThrow({ where: { id: memory.id } })).aboutCharacterId).toBeNull();
  });

  it("API 키 연결 삭제 시 사용량 집계는 삭제, 요청 로그의 connectionId는 NULL", async () => {
    const user = await createTestUser();
    const conn = await prisma.aiProviderConnection.create({
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
    await prisma.apiUsageDaily.create({ data: { connectionId: conn.id, usageDate: new Date("2026-10-27") } });
    const log = await prisma.apiRequestLog.create({
      data: { userId: user.id, connectionId: conn.id, model: "mock", startedAt: new Date(), outcome: "HTTP_ERROR", httpStatus: 429 },
    });

    await prisma.aiProviderConnection.delete({ where: { id: conn.id } });

    expect(await prisma.apiUsageDaily.count({ where: { connectionId: conn.id } })).toBe(0);
    expect((await prisma.apiRequestLog.findUniqueOrThrow({ where: { id: log.id } })).connectionId).toBeNull();
  });

  it("스냅샷 삭제 시 RECOVERY는 snapshotId NULL(복구 지점 없음)이 되고, MANUAL이 참조하면 CHECK로 막힌다", async () => {
    const { world } = await createWorldWithCharacters(0);
    const autoSnapshot = await prisma.gameSnapshot.create({ data: snapshotData(world.id) });
    await prisma.saveGame.update({ where: { recoveryForWorldId: world.id }, data: { snapshotId: autoSnapshot.id } });
    await prisma.gameSnapshot.delete({ where: { id: autoSnapshot.id } });
    expect((await prisma.saveGame.findUniqueOrThrow({ where: { recoveryForWorldId: world.id } })).snapshotId).toBeNull();

    const manualSnapshot = await prisma.gameSnapshot.create({ data: snapshotData(world.id) });
    await prisma.saveGame.create({
      data: {
        worldId: world.id,
        kind: "MANUAL",
        name: "슬롯",
        snapshotId: manualSnapshot.id,
        sceneCount: 0,
        characterCount: 0,
        worldNameSnapshot: world.name,
        stateVersionAtSave: 0,
      },
    });
    await expect(prisma.gameSnapshot.delete({ where: { id: manualSnapshot.id } })).rejects.toThrow(
      /save_kind_consistency/,
    );
  });
});

describe("소유권 조회 (CLAUDE.md 절대 규칙 3)", () => {
  it("world.ownerId 조건이 붙은 조회는 타인의 하위 리소스를 찾지 못한다", async () => {
    const { user: owner, world, characters } = await createWorldWithCharacters(1);
    const intruder = await createTestUser("intruder");
    const characterId = characters[0]!.id;

    const asOwner = await prisma.character.findFirst({ where: { id: characterId, world: { ownerId: owner.id } } });
    const asIntruder = await prisma.character.findFirst({
      where: { id: characterId, world: { ownerId: intruder.id } },
    });
    const worldAsIntruder = await prisma.world.findFirst({ where: { id: world.id, ownerId: intruder.id } });

    expect(asOwner?.id).toBe(characterId);
    expect(asIntruder).toBeNull();
    expect(worldAsIntruder).toBeNull();
  });

  it("세계관 목록 인덱스 World(ownerId, updatedAt DESC)가 있다", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'World'`;
    expect(rows.map((r) => r.indexdef)).toContainEqual(expect.stringMatching(/\("ownerId", "updatedAt" DESC\)/));
  });
});
