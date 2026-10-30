import { prisma } from "@/server/db/client";
import { NotFoundError } from "@/server/domain/errors";
import type { AuthenticatedUserId } from "@/server/domain/identity";

// 캐릭터 상세의 관계·기억 (Phase 5-5, PRD FR-06·FR-08). 런타임 독립, 읽기 전용.
// 소유자 세계관의 활성 캐릭터만 조회한다(없거나 타인 소유·삭제면 404). 변화 이력은 보여 주지 않고 현재 값만 준다.
// 관계 값은 현재 상태 → 없으면 사용자 baseline → 없으면 0 (scene-state.ts와 같은 규칙).

export type RelationValues = { affinity: number; trust: number; respect: number; familiarity: number };
export type CharacterRelationView = { otherId: string; otherName: string; outgoing: RelationValues; incoming: RelationValues };
export type CharacterMemoryView = {
  id: string;
  kind: string;
  acquisition: string;
  importance: number;
  content: string;
  aboutName: string | null;
  createdAt: Date;
  /** 출처 장면 번호·월드 시각 (장면 기록이 삭제됐거나 7-2-2 이전 장면이면 null) */
  sceneSeq: number | null;
  worldSeconds: number | null;
};

/**
 * 최근 감정 변화 (장면별 EmotionChange). 요인별 영향 점수는 저장하지 않으므로 이 기록이 "어느 장면에서 감정이 어떻게 바뀌었나"의 전부다.
 * dIntensity는 커밋에 반영된 강도 변화량(clamp 후)이며 긍정·부정 점수가 아니다.
 */
export type CharacterEmotionChangeView = {
  id: string;
  fromMood: string;
  toMood: string;
  dIntensity: number;
  sceneSeq: number | null;
  sceneTitle: string | null;
  worldSeconds: number | null;
};

/** 상세 화면에 보여 줄 기억 수 (최신순) */
const MEMORY_VIEW_LIMIT = 30;
/** 상세 화면에 보여 줄 감정 변화 수 (최신순, 변화 없는 기록은 뺀다) */
const EMOTION_CHANGE_VIEW_LIMIT = 5;
const ZERO: RelationValues = { affinity: 0, trust: 0, respect: 0, familiarity: 0 };

export async function getCharacterInsights(
  userId: AuthenticatedUserId,
  worldId: string,
  characterId: string,
): Promise<{ relations: CharacterRelationView[]; memories: CharacterMemoryView[]; emotionChanges: CharacterEmotionChangeView[] }> {
  const self = await prisma.character.findFirst({ where: { id: characterId, worldId, deletedAt: null, world: { ownerId: userId } }, select: { id: true } });
  if (!self) throw new NotFoundError();

  const others = await prisma.character.findMany({
    where: { worldId, deletedAt: null, id: { not: characterId } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  const pairWhere = { worldId, OR: [{ fromCharacterId: characterId }, { toCharacterId: characterId }] };
  const [states, baselines, memories, emotionChanges] = await Promise.all([
    prisma.relationshipState.findMany({ where: pairWhere }),
    prisma.relationshipBaseline.findMany({ where: pairWhere }),
    prisma.characterMemory.findMany({
      where: { worldId, ownerCharacterId: characterId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MEMORY_VIEW_LIMIT,
      select: {
        id: true,
        kind: true,
        acquisition: true,
        importance: true,
        content: true,
        createdAt: true,
        about: { select: { name: true } },
        sourceScene: { select: { seq: true, worldSeconds: true } },
      },
    }),
    prisma.emotionChange.findMany({
      where: { worldId, characterId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: EMOTION_CHANGE_VIEW_LIMIT * 2,
      select: { id: true, fromMood: true, toMood: true, dIntensity: true, scene: { select: { seq: true, title: true, worldSeconds: true } } },
    }),
  ]);
  const value = (from: string, to: string): RelationValues => {
    const row = states.find((s) => s.fromCharacterId === from && s.toCharacterId === to) ?? baselines.find((b) => b.fromCharacterId === from && b.toCharacterId === to);
    return row ? { affinity: row.affinity, trust: row.trust, respect: row.respect, familiarity: row.familiarity } : { ...ZERO };
  };
  return {
    relations: others.map((o) => ({ otherId: o.id, otherName: o.name, outgoing: value(characterId, o.id), incoming: value(o.id, characterId) })),
    memories: memories.map(({ about, sourceScene, ...m }) => ({
      ...m,
      aboutName: about?.name ?? null,
      sceneSeq: sourceScene?.seq ?? null,
      worldSeconds: sourceScene?.worldSeconds ?? null,
    })),
    emotionChanges: emotionChanges
      .filter((e) => e.dIntensity !== 0 || e.fromMood !== e.toMood)
      .slice(0, EMOTION_CHANGE_VIEW_LIMIT)
      .map(({ scene, ...e }) => ({ ...e, sceneSeq: scene?.seq ?? null, sceneTitle: scene?.title ?? null, worldSeconds: scene?.worldSeconds ?? null })),
  };
}
