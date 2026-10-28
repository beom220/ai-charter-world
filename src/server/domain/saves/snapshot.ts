import { createHash } from "node:crypto";
import { SNAPSHOT_SCHEMA_VERSION } from "../../../../config/limits";
import type { Prisma } from "@/generated/prisma/client";
import { snapshotReferenceError, snapshotV1Schema } from "@/lib/snapshot/v1";
import { migrateV1ToV2, snapshotBackgroundError, snapshotV2Schema, type SnapshotV2 } from "@/lib/snapshot/v2";
import { AppError } from "@/server/domain/errors";

// 스냅샷 캡처·검증·복원 (architecture.md §9.1·§9.2·§9.6, Phase 6). 런타임 독립.
// - capture/restore는 호출자의 트랜잭션 안에서 World → GameState 행 잠금을 잡은 뒤 부른다. 잠금 동안 장면 커밋·설정 편집이 끼어들 수 없으므로
//   한 시점의 일관된 상태만 담기고, 복원은 전부 반영되거나 전부 롤백된다.
// - checksum은 키를 정렬한 정규 JSON의 SHA-256이다(jsonb는 키 순서를 보존하지 않으므로). sizeBytes도 정규 JSON 기준이다.

type Tx = Prisma.TransactionClient;

export class SnapshotInvalidError extends AppError {
  constructor(readonly reason: string) {
    super(422, "SAVE_INVALID", reason === "NEWER_VERSION" ? "새 버전에서 만든 저장이라 불러올 수 없습니다." : "저장 데이터가 손상되었거나 형식이 올바르지 않아 불러올 수 없습니다.");
  }
}

/** 키를 정렬한 JSON (checksum 계산용) */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const snapshotChecksum = (payload: unknown) => {
  const text = canonicalJson(payload);
  return { checksum: createHash("sha256").update(text).digest("hex"), sizeBytes: Buffer.byteLength(text) };
};

/** 현재 버전 payload */
export type CurrentSnapshot = SnapshotV2;

/**
 * 저장된 행 → 검증된 현재 버전 payload. 버전 → checksum(저장된 원본 기준) → 버전별 Zod → 마이그레이션 → 참조 순으로 확인한다.
 * 저장된 원본은 바꾸지 않는다(읽을 때 변환, §9.6).
 */
export function parseSnapshot(row: { schemaVersion: number; payload: unknown; checksum: string }): CurrentSnapshot {
  if (row.schemaVersion > SNAPSHOT_SCHEMA_VERSION) throw new SnapshotInvalidError("NEWER_VERSION");
  if (snapshotChecksum(row.payload).checksum !== row.checksum) throw new SnapshotInvalidError("CHECKSUM");
  let snapshot: CurrentSnapshot;
  if (row.schemaVersion === 1) {
    const v1 = snapshotV1Schema.safeParse(row.payload);
    if (!v1.success) throw new SnapshotInvalidError("SCHEMA");
    snapshot = migrateV1ToV2(v1.data);
  } else {
    const v2 = snapshotV2Schema.safeParse(row.payload);
    if (!v2.success) throw new SnapshotInvalidError("SCHEMA");
    snapshot = v2.data;
  }
  const refError = snapshotReferenceError(snapshot) ?? snapshotBackgroundError(snapshot);
  if (refError) throw new SnapshotInvalidError(refError);
  return snapshot;
}

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/** 현재 활성 상태를 payload로 만든다 (호출자가 World·GameState 잠금을 잡은 트랜잭션) */
export async function captureSnapshot(tx: Tx, worldId: string, now: Date): Promise<CurrentSnapshot> {
  const where = { worldId };
  const [world, gs, characters, baselines, states, relChanges, emotions, emoChanges, memories, scenes, events] = await Promise.all([
    tx.world.findUniqueOrThrow({ where: { id: worldId } }),
    tx.gameState.findUniqueOrThrow({ where }),
    tx.character.findMany({ where, orderBy: { createdAt: "asc" } }),
    tx.relationshipBaseline.findMany({ where }),
    tx.relationshipState.findMany({ where }),
    tx.relationshipChange.findMany({ where, orderBy: { createdAt: "asc" } }),
    tx.emotionState.findMany({ where }),
    tx.emotionChange.findMany({ where, orderBy: { createdAt: "asc" } }),
    tx.characterMemory.findMany({ where, orderBy: { createdAt: "asc" } }),
    tx.conversationScene.findMany({ where, orderBy: { seq: "asc" }, include: { participants: true, messages: { orderBy: { turnIndex: "asc" } } } }),
    tx.worldEvent.findMany({ where, orderBy: { createdAt: "asc" } }),
  ]);
  const rel = (r: { affinity: number; trust: number; respect: number; familiarity: number }) => ({ affinity: r.affinity, trust: r.trust, respect: r.respect, familiarity: r.familiarity });
  return {
    schemaVersion: 2,
    capturedAt: iso(now),
    world: {
      name: world.name,
      summary: world.summary,
      eraAndPlace: world.eraAndPlace,
      worldRules: world.worldRules,
      currentSituation: world.currentSituation,
      worldContext: world.worldContext,
    },
    gameState: {
      nextSceneSeq: gs.nextSceneSeq,
      strategyMode: gs.strategyMode,
      intervalPreset: gs.intervalPreset,
      maxTurnsPerScene: gs.maxTurnsPerScene,
      participantsMin: gs.participantsMin,
      participantsMax: gs.participantsMax,
      modelOverride: gs.modelOverride,
      lastCommittedAt: isoOrNull(gs.lastCommittedAt),
    },
    characters: characters.map((c) => ({
      id: c.id,
      name: c.name,
      gender: c.gender,
      genderCustom: c.genderCustom,
      age: c.age,
      personalityTags: c.personalityTags,
      extraversion: c.extraversion,
      agreeableness: c.agreeableness,
      conscientiousness: c.conscientiousness,
      emotionalStability: c.emotionalStability,
      openness: c.openness,
      goal: c.goal,
      characterContext: c.characterContext,
      initialMood: c.initialMood,
      initialMoodIntensity: c.initialMoodIntensity,
      childhoodBackgroundId: c.childhoodBackgroundId,
      adulthoodBackgroundId: c.adulthoodBackgroundId,
      sortOrder: c.sortOrder,
      deletedAt: isoOrNull(c.deletedAt),
      createdAt: iso(c.createdAt),
    })),
    relationshipBaselines: baselines.map((b) => ({ id: b.id, fromCharacterId: b.fromCharacterId, toCharacterId: b.toCharacterId, ...rel(b) })),
    relationshipStates: states.map((r) => ({ id: r.id, fromCharacterId: r.fromCharacterId, toCharacterId: r.toCharacterId, ...rel(r) })),
    relationshipChanges: relChanges.map((c) => ({
      id: c.id,
      relationshipStateId: c.relationshipStateId,
      sceneId: c.sceneId,
      dAffinity: c.dAffinity,
      dTrust: c.dTrust,
      dRespect: c.dRespect,
      dFamiliarity: c.dFamiliarity,
      proposed: c.proposed as CurrentSnapshot["relationshipChanges"][number]["proposed"],
      clamped: c.clamped,
      reason: c.reason,
      createdAt: iso(c.createdAt),
    })),
    emotionStates: emotions.map((e) => ({ characterId: e.characterId, mood: e.mood, intensity: e.intensity })),
    emotionChanges: emoChanges.map((e) => ({
      id: e.id,
      characterId: e.characterId,
      sceneId: e.sceneId,
      fromMood: e.fromMood,
      toMood: e.toMood,
      dIntensity: e.dIntensity,
      proposedDelta: e.proposedDelta,
      clamped: e.clamped,
      createdAt: iso(e.createdAt),
    })),
    memories: memories.map((m) => ({
      id: m.id,
      ownerCharacterId: m.ownerCharacterId,
      aboutCharacterId: m.aboutCharacterId,
      kind: m.kind,
      acquisition: m.acquisition,
      content: m.content,
      importance: m.importance,
      sourceSceneId: m.sourceSceneId,
      shareGroupId: m.shareGroupId,
      createdAt: iso(m.createdAt),
    })),
    scenes: scenes.map((s) => ({
      id: s.id,
      seq: s.seq,
      attemptId: s.attemptId,
      runId: s.runId,
      strategyMode: s.strategyMode,
      model: s.model,
      title: s.title,
      summary: s.summary,
      motiveType: s.motiveType,
      motiveRef: s.motiveRef,
      endReason: s.endReason,
      contextTruncated: s.contextTruncated,
      createdAt: iso(s.createdAt),
      participants: s.participants.map((p) => ({ characterId: p.characterId, alias: p.alias, nameSnapshot: p.nameSnapshot })),
      messages: s.messages.map((m) => ({
        id: m.id,
        turnIndex: m.turnIndex,
        speakerCharacterId: m.speakerCharacterId,
        speakerNameSnapshot: m.speakerNameSnapshot,
        dialogue: m.dialogue,
        actionIntent: m.actionIntent,
        emotionCue: m.emotionCue,
        createdAt: iso(m.createdAt),
      })),
    })),
    worldEvents: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      description: e.description,
      visibility: e.visibility,
      status: e.status,
      sourceSceneId: e.sourceSceneId,
      createdAt: iso(e.createdAt),
      resolvedAt: isoOrNull(e.resolvedAt),
    })),
  };
}

/**
 * 활성 상태를 payload로 교체한다 (호출자가 World → GameState → Runtime 잠금을 잡은 트랜잭션).
 * 진행 상태를 모두 지운 뒤 스냅샷에 없는 캐릭터는 지우고, 설정·진행 상태를 원래 ID로 다시 만든다.
 * stateVersion·changeSeq·settingsSeq를 1씩 올려 이전 시도의 늦은 커밋과 이전 설정으로 준비한 시도를 막는다. 새 changeSeq를 돌려준다.
 */
export async function restoreSnapshot(tx: Tx, worldId: string, p: CurrentSnapshot): Promise<{ stateVersion: number; changeSeq: number }> {
  const where = { worldId };
  // 1) 진행 상태 삭제 (FK 의존 순서)
  await tx.characterMemory.deleteMany({ where });
  await tx.emotionChange.deleteMany({ where });
  await tx.relationshipChange.deleteMany({ where });
  await tx.worldEvent.deleteMany({ where });
  await tx.relationshipState.deleteMany({ where });
  await tx.emotionState.deleteMany({ where });
  await tx.message.deleteMany({ where });
  await tx.sceneParticipant.deleteMany({ where });
  await tx.conversationScene.deleteMany({ where });
  await tx.relationshipBaseline.deleteMany({ where });

  // 2) 설정: 세계관, 캐릭터 (스냅샷 이후에 만든 캐릭터는 제거)
  await tx.world.update({ where: { id: worldId }, data: p.world });
  const keep = p.characters.map((c) => c.id);
  // 다른 세계관의 행과 ID가 겹치면 덮어쓰지 않고 거부한다 (ID는 이 세계관에서만 나온다. 방어적 확인)
  if ((await tx.character.count({ where: { id: { in: keep }, worldId: { not: worldId } } })) > 0) throw new SnapshotInvalidError("FOREIGN_CHARACTER");
  await tx.character.deleteMany({ where: { worldId, id: { notIn: keep } } });
  for (const c of p.characters) {
    const data = { ...c, deletedAt: c.deletedAt ? new Date(c.deletedAt) : null, createdAt: new Date(c.createdAt) };
    await tx.character.upsert({ where: { id: c.id }, create: { ...data, worldId }, update: data });
  }

  // 3) 진행 상태 재생성
  const at = (s: string) => new Date(s);
  if (p.relationshipBaselines.length) await tx.relationshipBaseline.createMany({ data: p.relationshipBaselines.map((b) => ({ ...b, worldId })) });
  if (p.relationshipStates.length) await tx.relationshipState.createMany({ data: p.relationshipStates.map((r) => ({ ...r, worldId })) });
  if (p.emotionStates.length) await tx.emotionState.createMany({ data: p.emotionStates.map((e) => ({ ...e, worldId })) });
  // 장면의 Run은 통계용 참조다. 이 세계관에 남아 있는 Run만 잇는다
  const runIds = new Set(
    (await tx.simulationRun.findMany({ where: { worldId, id: { in: p.scenes.flatMap((s) => (s.runId ? [s.runId] : [])) } }, select: { id: true } })).map((r) => r.id),
  );
  if (p.scenes.length) {
    await tx.conversationScene.createMany({
      data: p.scenes.map((s) => ({
        id: s.id,
        worldId,
        seq: s.seq,
        attemptId: s.attemptId,
        runId: s.runId && runIds.has(s.runId) ? s.runId : null,
        strategyMode: s.strategyMode,
        model: s.model,
        title: s.title,
        summary: s.summary,
        motiveType: s.motiveType,
        motiveRef: s.motiveRef,
        endReason: s.endReason,
        contextTruncated: s.contextTruncated,
        createdAt: at(s.createdAt),
      })),
    });
    const participants = p.scenes.flatMap((s) => s.participants.map((x) => ({ ...x, sceneId: s.id, worldId })));
    if (participants.length) await tx.sceneParticipant.createMany({ data: participants });
    const messages = p.scenes.flatMap((s) => s.messages.map((m) => ({ ...m, sceneId: s.id, worldId, createdAt: at(m.createdAt) })));
    if (messages.length) await tx.message.createMany({ data: messages });
  }
  if (p.relationshipChanges.length) {
    await tx.relationshipChange.createMany({
      data: p.relationshipChanges.map((c) => ({ ...c, worldId, proposed: c.proposed ?? {}, createdAt: at(c.createdAt) })),
    });
  }
  if (p.emotionChanges.length) await tx.emotionChange.createMany({ data: p.emotionChanges.map((e) => ({ ...e, worldId, createdAt: at(e.createdAt) })) });
  if (p.memories.length) await tx.characterMemory.createMany({ data: p.memories.map((m) => ({ ...m, worldId, createdAt: at(m.createdAt) })) });
  if (p.worldEvents.length) {
    await tx.worldEvent.createMany({ data: p.worldEvents.map((e) => ({ ...e, worldId, createdAt: at(e.createdAt), resolvedAt: e.resolvedAt ? at(e.resolvedAt) : null })) });
  }

  // 4) GameState: 진행 값·실행 설정 복원 + 펜싱 토큰 증가
  const gs = await tx.gameState.update({
    where,
    data: {
      ...p.gameState,
      lastCommittedAt: p.gameState.lastCommittedAt ? at(p.gameState.lastCommittedAt) : null,
      stateVersion: { increment: 1 },
      changeSeq: { increment: 1 },
      settingsSeq: { increment: 1 },
    },
    select: { stateVersion: true, changeSeq: true },
  });
  return gs;
}
