import { z } from "zod";
import { MAX_ACTIVE_CHARACTERS_PER_WORLD } from "../../../config/limits";

// 게임 스냅샷 payload v1 (architecture.md §9.1·§9.6, Phase 6). 서버·클라이언트 공용 Zod 스키마.
// 세계관 설정 + 캐릭터(삭제 포함) + 초기 관계 + 활성 진행 상태(감정·관계·기억·장면·발언·사건)와 변화 이력, GameState 진행 값.
// 제외: API 키·연결, 인증, 사용량·브레이커·로그, SimulationRun, Runtime(lease·inFlight), SSE 연결, outbox.
// 모든 행은 원래 ID를 그대로 담는다(복원 시 같은 ID로 다시 만든다). 날짜는 ISO 문자열.
// 구조를 바꾸면 v2.ts를 만들고 SNAPSHOT_SCHEMA_VERSION을 올리며, 마이그레이터와 이전 버전 픽스처 테스트를 함께 둔다(CLAUDE.md 규칙 10).

const id = z.string().min(1).max(64);
const date = z.iso.datetime();
const optDate = date.nullable();
const int = z.number().int();

const MOODS = ["NEUTRAL", "HAPPY", "EXCITED", "CALM", "SAD", "ANXIOUS", "ANGRY", "FEARFUL", "EMBARRASSED", "LONELY", "HOPEFUL", "TIRED"] as const;

const relationValues = { affinity: int, trust: int, respect: int, familiarity: int };

export const snapshotV1Schema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: date,
  world: z.object({
    name: z.string().min(1).max(100),
    summary: z.string().nullable(),
    eraAndPlace: z.string().nullable(),
    worldRules: z.string().nullable(),
    currentSituation: z.string().nullable(),
    worldContext: z.string(),
  }),
  gameState: z.object({
    nextSceneSeq: int.min(1),
    strategyMode: z.enum(["STORY", "AGENT"]),
    intervalPreset: z.enum(["SLOW", "NORMAL", "FAST"]),
    maxTurnsPerScene: int,
    participantsMin: int,
    participantsMax: int,
    modelOverride: z.string().nullable(),
    lastCommittedAt: optDate,
  }),
  characters: z.array(
    z.object({
      id,
      name: z.string().min(1).max(50),
      gender: z.enum(["MALE", "FEMALE", "NONBINARY", "CUSTOM", "UNSPECIFIED"]),
      genderCustom: z.string().max(30).nullable(),
      age: int.nullable(),
      personalityTags: z.array(z.string()),
      extraversion: int,
      agreeableness: int,
      conscientiousness: int,
      emotionalStability: int,
      openness: int,
      goal: z.string().nullable(),
      characterContext: z.string(),
      initialMood: z.enum(MOODS),
      initialMoodIntensity: int,
      sortOrder: int,
      deletedAt: optDate,
      createdAt: date,
    }),
  ),
  relationshipBaselines: z.array(z.object({ id, fromCharacterId: id, toCharacterId: id, ...relationValues })),
  relationshipStates: z.array(z.object({ id, fromCharacterId: id, toCharacterId: id, ...relationValues })),
  relationshipChanges: z.array(
    z.object({
      id,
      relationshipStateId: id,
      sceneId: id.nullable(),
      dAffinity: int,
      dTrust: int,
      dRespect: int,
      dFamiliarity: int,
      proposed: z.json(),
      clamped: z.boolean(),
      reason: z.string().nullable(),
      createdAt: date,
    }),
  ),
  emotionStates: z.array(z.object({ characterId: id, mood: z.enum(MOODS), intensity: int })),
  emotionChanges: z.array(
    z.object({
      id,
      characterId: id,
      sceneId: id.nullable(),
      fromMood: z.enum(MOODS),
      toMood: z.enum(MOODS),
      dIntensity: int,
      proposedDelta: int,
      clamped: z.boolean(),
      createdAt: date,
    }),
  ),
  memories: z.array(
    z.object({
      id,
      ownerCharacterId: id,
      aboutCharacterId: id.nullable(),
      kind: z.enum(["EVENT", "PROMISE", "CONFESSION", "CONFLICT", "SECRET", "IMPRESSION", "OTHER"]),
      acquisition: z.enum(["WITNESSED", "TOLD", "OBSERVED"]),
      content: z.string(),
      importance: int.min(1).max(5),
      sourceSceneId: id.nullable(),
      shareGroupId: z.string().nullable(),
      createdAt: date,
    }),
  ),
  scenes: z.array(
    z.object({
      id,
      seq: int.min(1),
      attemptId: z.string().min(1),
      runId: id.nullable(),
      strategyMode: z.enum(["STORY", "AGENT"]),
      model: z.string(),
      title: z.string().max(100),
      summary: z.string(),
      motiveType: z.enum(["WORLD_EVENT", "RELATIONSHIP", "GOAL", "MIXED"]),
      motiveRef: z.string().nullable(),
      endReason: z.enum(["RESOLVED", "INTERRUPTED", "STALEMATE", "TURN_LIMIT"]),
      contextTruncated: z.boolean(),
      createdAt: date,
      participants: z.array(z.object({ characterId: id, alias: z.string().max(3), nameSnapshot: z.string().max(50) })),
      messages: z.array(
        z.object({
          id,
          turnIndex: int.min(0),
          speakerCharacterId: id.nullable(),
          speakerNameSnapshot: z.string().max(50),
          dialogue: z.string(),
          actionIntent: z.string().nullable(),
          emotionCue: z.string().max(40).nullable(),
          createdAt: date,
        }),
      ),
    }),
  ),
  worldEvents: z.array(
    z.object({
      id,
      kind: z.enum(["INITIAL_SITUATION", "SCENE_OUTCOME", "USER_INTERVENTION"]),
      title: z.string().max(100),
      description: z.string(),
      visibility: z.enum(["PUBLIC", "PARTICIPANTS"]),
      status: z.enum(["ACTIVE", "RESOLVED"]),
      sourceSceneId: id.nullable(),
      createdAt: date,
      resolvedAt: optDate,
    }),
  ),
});

export type SnapshotV1 = z.infer<typeof snapshotV1Schema>;

/**
 * 참조 관계 검사. 모든 캐릭터·장면·관계 참조가 스냅샷 안에 있어야 하고, ID·장면 번호가 중복되지 않으며,
 * 활성 캐릭터가 6명 이하여야 한다. 문제가 있으면 고정 코드, 없으면 null
 */
export function snapshotReferenceError(
  // 이후 버전의 사건·캐릭터 형식도 받는다(캐릭터는 id·deletedAt만 본다. v6은 goal이 없다)
  p: Omit<SnapshotV1, "schemaVersion" | "worldEvents" | "characters"> & {
    worldEvents: Pick<SnapshotV1["worldEvents"][number], "sourceSceneId">[];
    characters: Pick<SnapshotV1["characters"][number], "id" | "deletedAt">[];
  },
): string | null {
  const characters = new Set(p.characters.map((c) => c.id));
  const scenes = new Set(p.scenes.map((s) => s.id));
  const states = new Set(p.relationshipStates.map((r) => r.id));
  const has = (set: Set<string>, v: string | null) => v === null || set.has(v);
  const unique = (ids: string[]) => new Set(ids).size === ids.length;

  if (!unique(p.characters.map((c) => c.id)) || !unique(p.scenes.map((s) => s.id)) || !unique(p.scenes.map((s) => String(s.seq)))) return "DUPLICATE_ID";
  if (!unique(p.scenes.flatMap((s) => s.messages.map((m) => m.id))) || !unique(p.memories.map((m) => m.id)) || !unique(p.relationshipStates.map((r) => r.id))) {
    return "DUPLICATE_ID";
  }
  if (p.characters.filter((c) => c.deletedAt === null).length > MAX_ACTIVE_CHARACTERS_PER_WORLD) return "TOO_MANY_CHARACTERS";
  const pairOk = (r: { fromCharacterId: string; toCharacterId: string }) => characters.has(r.fromCharacterId) && characters.has(r.toCharacterId) && r.fromCharacterId !== r.toCharacterId;
  if (!p.relationshipBaselines.every(pairOk) || !p.relationshipStates.every(pairOk)) return "BAD_RELATIONSHIP_REF";
  if (!p.relationshipChanges.every((c) => states.has(c.relationshipStateId) && has(scenes, c.sceneId))) return "BAD_RELATIONSHIP_CHANGE_REF";
  if (!p.emotionStates.every((e) => characters.has(e.characterId))) return "BAD_EMOTION_REF";
  if (!p.emotionChanges.every((e) => characters.has(e.characterId) && has(scenes, e.sceneId))) return "BAD_EMOTION_REF";
  if (!p.memories.every((m) => characters.has(m.ownerCharacterId) && has(characters, m.aboutCharacterId) && has(scenes, m.sourceSceneId))) return "BAD_MEMORY_REF";
  for (const s of p.scenes) {
    if (s.seq >= p.gameState.nextSceneSeq) return "BAD_SCENE_SEQ";
    if (!s.participants.every((x) => characters.has(x.characterId)) || !s.messages.every((m) => has(characters, m.speakerCharacterId))) return "BAD_SCENE_REF";
    if (!unique(s.messages.map((m) => String(m.turnIndex))) || !unique(s.participants.map((x) => x.characterId))) return "DUPLICATE_ID";
  }
  if (!p.worldEvents.every((e) => has(scenes, e.sourceSceneId))) return "BAD_EVENT_REF";
  return null;
}
