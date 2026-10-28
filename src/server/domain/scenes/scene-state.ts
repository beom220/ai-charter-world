import { EMOTION_DEFAULT, SCENE_MEMORY_PER_CHARACTER } from "../../../../config/limits";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { planEmotionChanges, planRelationshipChanges, type RelationshipValue } from "@/server/engine/commit/state-changes";
import type { PromptMemory, PromptRelation } from "@/server/engine/context/story-prompt";
import type { SceneAlias, SceneProposals } from "@/server/engine/validation/scene-output";
import type { AuthenticatedUserId } from "@/server/domain/identity";

// 장면 참가자의 감정·관계·기억 (Phase 5-5, architecture.md §6.4·§6.7). 런타임 독립.
// - loadParticipantContext: 프롬프트용. 참가자 사이의 관계(현재 값 → 없으면 사용자 baseline → 없으면 0)와
//   참가자 각자가 소유한 기억(중요도·최신순 최대 8개). 세계관 소유자 조건으로만 읽는다.
// - applySceneProposals: 장면 커밋 트랜잭션 안에서 검증된 제안을 반영한다(clamp는 engine/commit/state-changes).
//   참조는 이번 장면 참가자(별칭 → 이 세계관의 캐릭터 ID)로만 되돌리므로 다른 세계관·비참가자 캐릭터를 바꿀 수 없다.
//   DB의 복합 FK(characterId, worldId)가 2차로 막는다.

type Participant = { id: string; alias: SceneAlias; name: string };
type Tx = Prisma.TransactionClient;

const ZERO: RelationshipValue = { affinity: 0, trust: 0, respect: 0, familiarity: 0 };
const pick = (r: RelationshipValue): RelationshipValue => ({ affinity: r.affinity, trust: r.trust, respect: r.respect, familiarity: r.familiarity });

async function relationshipLookup(db: Tx | typeof prisma, worldId: string, ids: string[]) {
  const where = { worldId, fromCharacterId: { in: ids }, toCharacterId: { in: ids } };
  const [states, baselines] = await Promise.all([db.relationshipState.findMany({ where }), db.relationshipBaseline.findMany({ where })]);
  const key = (from: string, to: string) => `${from}>${to}`;
  const stateMap = new Map(states.map((s) => [key(s.fromCharacterId, s.toCharacterId), s]));
  const baseMap = new Map(baselines.map((b) => [key(b.fromCharacterId, b.toCharacterId), b]));
  return (from: string, to: string): RelationshipValue => {
    const row = stateMap.get(key(from, to)) ?? baseMap.get(key(from, to));
    return row ? pick(row) : { ...ZERO };
  };
}

export async function loadParticipantContext(
  userId: AuthenticatedUserId,
  worldId: string,
  participants: Participant[],
): Promise<Map<string, { relations: PromptRelation[]; memories: PromptMemory[] }>> {
  const ids = participants.map((p) => p.id);
  const owned = await prisma.world.count({ where: { id: worldId, ownerId: userId } });
  if (owned === 0) return new Map();
  const relationOf = await relationshipLookup(prisma, worldId, ids);
  const memories = await Promise.all(
    ids.map((id) =>
      prisma.characterMemory.findMany({
        where: { worldId, ownerCharacterId: id },
        orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
        take: SCENE_MEMORY_PER_CHARACTER,
        select: { content: true, kind: true, acquisition: true, importance: true, about: { select: { name: true } } },
      }),
    ),
  );
  return new Map(
    participants.map((p, i) => [
      p.id,
      {
        relations: participants.filter((o) => o.id !== p.id).map((o) => ({ toAlias: o.alias, toName: o.name, ...relationOf(p.id, o.id) })),
        memories: memories[i]!.map((m) => ({ content: m.content, kind: m.kind, acquisition: m.acquisition, importance: m.importance, aboutName: m.about?.name ?? null })),
      },
    ]),
  );
}

/** 커밋 트랜잭션 안에서 감정 → 관계 → 기억 순으로 반영한다. 실패하면 트랜잭션 전체가 롤백된다 */
export async function applySceneProposals(tx: Tx, worldId: string, sceneId: string, participants: Participant[], proposals: SceneProposals): Promise<void> {
  const byAlias = new Map(participants.map((p) => [p.alias, p]));
  const idOf = (alias: SceneAlias) => {
    const p = byAlias.get(alias);
    if (!p) throw new Error("UNKNOWN_ALIAS"); // 검증에서 이미 막는다. 여기 오면 프로그램 오류
    return p.id;
  };
  const ids = participants.map((p) => p.id);

  // 1) 감정 (장면당 ±20, 0..100)
  const emotionRows = await tx.emotionState.findMany({ where: { worldId, characterId: { in: ids } } });
  const emotionOf = new Map(emotionRows.map((e) => [e.characterId, { mood: e.mood, intensity: e.intensity }]));
  for (const plan of planEmotionChanges(proposals.emotions, (a) => emotionOf.get(idOf(a)) ?? { ...EMOTION_DEFAULT })) {
    const characterId = idOf(plan.alias);
    await tx.emotionState.upsert({
      where: { characterId },
      create: { characterId, worldId, mood: plan.to.mood, intensity: plan.to.intensity },
      update: { mood: plan.to.mood, intensity: plan.to.intensity },
    });
    await tx.emotionChange.create({
      data: {
        worldId,
        characterId,
        sceneId,
        fromMood: plan.from.mood,
        toMood: plan.to.mood,
        dIntensity: plan.dIntensity,
        proposedDelta: plan.proposedDelta,
        clamped: plan.clamped,
      },
    });
  }

  // 2) 관계 (축별 ±5, 범위 clamp). 없던 쌍은 baseline 또는 0에서 시작한다
  const relationOf = await relationshipLookup(tx, worldId, ids);
  for (const plan of planRelationshipChanges(proposals.relationships, (f, t) => relationOf(idOf(f), idOf(t)))) {
    const fromCharacterId = idOf(plan.from);
    const toCharacterId = idOf(plan.to);
    const state = await tx.relationshipState.upsert({
      where: { fromCharacterId_toCharacterId: { fromCharacterId, toCharacterId } },
      create: { worldId, fromCharacterId, toCharacterId, ...plan.after },
      update: plan.after,
      select: { id: true },
    });
    const { affinity, trust, respect, familiarity } = plan.applied;
    await tx.relationshipChange.create({
      data: {
        worldId,
        relationshipStateId: state.id,
        sceneId,
        dAffinity: affinity,
        dTrust: trust,
        dRespect: respect,
        dFamiliarity: familiarity,
        proposed: plan.proposed,
        clamped: plan.clamped,
        reason: plan.reason,
      },
    });
  }

  // 3) 기억 (참가자 = 목격자만 소유자. 중요도 1..5 clamp, 개수는 검증 단계에서 제한)
  if (proposals.memories.length) {
    await tx.characterMemory.createMany({
      data: proposals.memories.map((m) => ({
        worldId,
        ownerCharacterId: idOf(m.owner),
        aboutCharacterId: m.about ? idOf(m.about) : null,
        kind: m.kind,
        acquisition: m.acquisition,
        content: m.content,
        importance: Math.min(5, Math.max(1, m.importance)),
        sourceSceneId: sceneId,
      })),
    });
  }
}
