import { z } from "zod";
import { USER_EVENT_PENDING_MAX, USER_EVENT_TEXT_MAX_LENGTH } from "../../../config/limits";
import { findEventPreset } from "../../../config/world-events";
import { snapshotV2Schema, type SnapshotV2 } from "./v2";

// 게임 스냅샷 payload v3 (Phase 7-2). v2 + 사건 시스템(WorldEvent 확장·자동 사건 20장면 구간 추첨 기록) + 캐릭터 신체 상태와 변화 이력.
// v1·v2는 저장된 원본(그리고 checksum)을 그대로 두고, 읽을 때 v1 → v2 → v3 순으로 바꾼다(architecture.md §9.6).
// v2 → v3: 사건은 새 필드 NULL(진행 장면 정보 없음), 구간 추첨 기록 없음(다음 판정 때 현재 장면부터 추첨), 모든 캐릭터 생존·정상·부상 없음.

const id = z.string().min(1).max(64);
const date = z.iso.datetime();
const int = z.number().int();
const seq = int.min(1).nullable();

const worldEventV3Schema = z.object({
  id,
  kind: z.enum(["INITIAL_SITUATION", "SCENE_OUTCOME", "USER_INTERVENTION", "RANDOM"]),
  title: z.string().max(100),
  description: z.string(),
  visibility: z.enum(["PUBLIC", "PARTICIPANTS"]),
  status: z.enum(["PENDING", "ACTIVE", "RESOLVED", "CANCELLED"]),
  sourceSceneId: id.nullable(),
  createdAt: date,
  resolvedAt: date.nullable(),
  presetId: id.nullable(),
  intensity: z.enum(["LOW", "MEDIUM", "HIGH"]).nullable(),
  requestId: id.nullable(),
  startedSceneSeq: seq,
  lastSceneSeq: seq,
  resolvedSceneSeq: seq,
  resolutionSummary: z.string().nullable(),
  cancelledAt: date.nullable(),
  // claimedAttemptId(진행 중 시도 점유)는 담지 않는다: 불러오기는 진행 중 시도가 없을 때만 하고, 복원하면 점유가 풀린다
});

const injury = z.enum(["NONE", "MILD", "MODERATE", "SEVERE", "CRITICAL"]);

export const snapshotV3Schema = snapshotV2Schema.extend({
  schemaVersion: z.literal(3),
  worldEvents: z.array(worldEventV3Schema),
  eventPeriods: z.array(
    z.object({
      periodIndex: int.min(0),
      won: z.boolean(),
      scheduledSceneSeq: seq,
      presetId: id.nullable(),
      eventId: id.nullable(),
      firedAt: date.nullable(),
      createdAt: date,
    }),
  ),
  characterConditions: z.array(
    z.object({
      characterId: id,
      thermal: z.enum(["NORMAL", "COLD", "VERY_COLD", "HOT", "VERY_HOT"]),
      injury,
      injuryCause: z.string().max(200).nullable(),
      injurySceneSeq: seq,
      injuryUpdatedSceneSeq: seq,
      vital: z.enum(["ALIVE", "DEAD"]),
      deathCause: z.string().max(200).nullable(),
      deathSceneSeq: seq,
      diedAt: date.nullable(),
    }),
  ),
  conditionChanges: z.array(
    z.object({
      id,
      characterId: id,
      sceneId: id.nullable(),
      eventId: id.nullable(),
      kind: z.enum(["THERMAL", "INJURY", "TREATMENT", "RECOVERY", "DEATH"]),
      fromValue: z.string().max(20),
      toValue: z.string().max(20),
      reason: z.string().max(200).nullable(),
      createdAt: date,
    }),
  ),
});

export type SnapshotV3 = z.infer<typeof snapshotV3Schema>;

const defaultCondition = (characterId: string): SnapshotV3["characterConditions"][number] => ({
  characterId,
  thermal: "NORMAL",
  injury: "NONE",
  injuryCause: null,
  injurySceneSeq: null,
  injuryUpdatedSceneSeq: null,
  vital: "ALIVE",
  deathCause: null,
  deathSceneSeq: null,
  diedAt: null,
});

/** v2 → v3: 사건 새 필드 NULL, 구간 추첨 기록 없음, 모든 캐릭터 생존·정상·부상 없음 */
export function migrateV2ToV3(p: SnapshotV2): SnapshotV3 {
  return {
    ...p,
    schemaVersion: 3,
    worldEvents: p.worldEvents.map((e) => ({
      ...e,
      presetId: null,
      intensity: null,
      requestId: null,
      startedSceneSeq: null,
      lastSceneSeq: null,
      resolvedSceneSeq: null,
      resolutionSummary: null,
      cancelledAt: null,
    })),
    eventPeriods: [],
    characterConditions: p.characters.map((c) => defaultCondition(c.id)),
    conditionChanges: [],
  };
}

/** v3에서 추가된 부분의 참조·불변식 검사. 문제가 있으면 고정 코드, 없으면 null */
export function snapshotV3Error(
  p: Pick<SnapshotV3, "characters" | "scenes" | "worldEvents" | "eventPeriods" | "conditionChanges"> & {
    characterConditions: Pick<SnapshotV3["characterConditions"][number], "characterId" | "injury" | "injuryCause" | "vital" | "deathCause" | "deathSceneSeq" | "diedAt">[];
  }, // v4의 신체 상태 형식도 받는다
): string | null {
  const characters = new Set(p.characters.map((c) => c.id));
  const scenes = new Set(p.scenes.map((s) => s.id));
  const events = new Set(p.worldEvents.map((e) => e.id));
  const has = (set: Set<string>, v: string | null) => v === null || set.has(v);
  const unique = (ids: string[]) => new Set(ids).size === ids.length;

  if (!unique(p.worldEvents.map((e) => e.id)) || !unique(p.conditionChanges.map((c) => c.id))) return "DUPLICATE_ID";
  if (!unique(p.eventPeriods.map((x) => String(x.periodIndex))) || !unique(p.characterConditions.map((c) => c.characterId))) return "DUPLICATE_ID";
  if (!unique(p.worldEvents.flatMap((e) => (e.requestId ? [e.requestId] : [])))) return "DUPLICATE_ID";
  // 사건: 프리셋 ID는 알려진 것만, 사용자 사건은 200자 이하, 대기 최대 3건 (USER_EVENT_PENDING_MAX)
  for (const e of p.worldEvents) {
    if (e.presetId !== null && !findEventPreset(e.presetId)) return "BAD_EVENT_PRESET";
    if (e.kind === "USER_INTERVENTION" && [...e.description].length > USER_EVENT_TEXT_MAX_LENGTH) return "BAD_EVENT";
    // 대기는 사용자 사건만, 아직 반영된 장면이 없어야 한다
    if (e.status === "PENDING" && (e.kind !== "USER_INTERVENTION" || e.startedSceneSeq !== null)) return "BAD_EVENT";
  }
  if (p.worldEvents.filter((e) => e.status === "PENDING").length > USER_EVENT_PENDING_MAX) return "BAD_EVENT";
  // 구간: 당첨 ⇔ 예약 장면, 연결된 사건·프리셋
  for (const x of p.eventPeriods) {
    if (x.won !== (x.scheduledSceneSeq !== null)) return "BAD_EVENT_PERIOD";
    if (!has(events, x.eventId) || (x.presetId !== null && !findEventPreset(x.presetId))) return "BAD_EVENT_PERIOD";
  }
  // 신체 상태: 모든 캐릭터에 정확히 하나, 사망 기록·부상 원인
  if (p.characterConditions.length !== p.characters.length || !p.characterConditions.every((c) => characters.has(c.characterId))) return "BAD_CONDITION_REF";
  for (const c of p.characterConditions) {
    if (c.vital === "DEAD" && (c.deathCause === null || c.deathSceneSeq === null || c.diedAt === null)) return "BAD_CONDITION";
    if (c.injury !== "NONE" && c.injuryCause === null) return "BAD_CONDITION";
  }
  if (!p.conditionChanges.every((c) => characters.has(c.characterId) && has(scenes, c.sceneId) && has(events, c.eventId))) return "BAD_CONDITION_REF";
  return null;
}
