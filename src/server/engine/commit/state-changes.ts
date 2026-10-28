import {
  EMOTION_INTENSITY_DELTA_MAX,
  EMOTION_INTENSITY_RANGE,
  RELATIONSHIP_AXIS_DELTA_MAX,
  RELATIONSHIP_AXIS_RANGE,
  RELATIONSHIP_FAMILIARITY_RANGE,
} from "../../../../config/limits";
import type { Mood } from "@/generated/prisma/client";
import type { SceneAlias, SceneProposals } from "../validation/scene-output";

// 감정·관계 변화 계산 (architecture.md §6.6 clamp 규칙, A15). 런타임 독립 순수 함수.
// 서버가 상태 변화의 기준이다: LLM 제안을 별칭별로 합산 → 장면당 상한(감정 ±20, 관계 축별 ±5)으로 자르고 →
// 값 범위(감정 0..100, 호감·신뢰·존중 -100..100, 친밀 0..100)로 자른다. 실제 적용량(d*)과 원 제안값을 함께 돌려준다.

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export type EmotionValue = { mood: Mood; intensity: number };
export type EmotionPlan = {
  alias: SceneAlias;
  from: EmotionValue;
  to: EmotionValue;
  /** 실제 적용된 강도 변화 */
  dIntensity: number;
  /** LLM 제안 합계 (clamp 전) */
  proposedDelta: number;
  clamped: boolean;
};

/** 같은 캐릭터 제안이 여럿이면 강도는 합산, 감정은 마지막 제안을 쓴다 */
export function planEmotionChanges(proposals: SceneProposals["emotions"], current: (alias: SceneAlias) => EmotionValue): EmotionPlan[] {
  const merged = new Map<SceneAlias, { mood: Mood; sum: number }>();
  for (const p of proposals) {
    const prev = merged.get(p.character);
    merged.set(p.character, { mood: p.mood, sum: (prev?.sum ?? 0) + p.intensityDelta });
  }
  return [...merged].map(([alias, { mood, sum }]) => {
    const from = current(alias);
    const limited = clamp(sum, -EMOTION_INTENSITY_DELTA_MAX, EMOTION_INTENSITY_DELTA_MAX);
    const intensity = clamp(from.intensity + limited, EMOTION_INTENSITY_RANGE.min, EMOTION_INTENSITY_RANGE.max);
    return {
      alias,
      from,
      to: { mood, intensity },
      dIntensity: intensity - from.intensity,
      proposedDelta: sum,
      clamped: limited !== sum || intensity !== from.intensity + limited,
    };
  });
}

export const RELATIONSHIP_AXES = ["affinity", "trust", "respect", "familiarity"] as const;
export type RelationshipAxis = (typeof RELATIONSHIP_AXES)[number];
export type RelationshipValue = Record<RelationshipAxis, number>;
export type RelationshipPlan = {
  from: SceneAlias;
  to: SceneAlias;
  before: RelationshipValue;
  after: RelationshipValue;
  /** 실제 적용된 축별 변화 */
  applied: RelationshipValue;
  /** LLM 제안 합계 (clamp 전) */
  proposed: RelationshipValue;
  clamped: boolean;
  reason: string | null;
};

const axisRange = (axis: RelationshipAxis) => (axis === "familiarity" ? RELATIONSHIP_FAMILIARITY_RANGE : RELATIONSHIP_AXIS_RANGE);

/** 같은 (from,to) 제안은 합산 후 clamp한다 (§6.6). 이유는 첫 번째 것을 쓴다 */
export function planRelationshipChanges(
  proposals: SceneProposals["relationships"],
  current: (from: SceneAlias, to: SceneAlias) => RelationshipValue,
): RelationshipPlan[] {
  const merged = new Map<string, { from: SceneAlias; to: SceneAlias; sum: RelationshipValue; reason: string | null }>();
  for (const p of proposals) {
    const key = `${p.from}>${p.to}`;
    const prev = merged.get(key) ?? { from: p.from, to: p.to, sum: { affinity: 0, trust: 0, respect: 0, familiarity: 0 }, reason: null };
    for (const axis of RELATIONSHIP_AXES) prev.sum[axis] += p[axis];
    prev.reason ??= p.reason;
    merged.set(key, prev);
  }
  return [...merged.values()].map(({ from, to, sum, reason }) => {
    const before = current(from, to);
    const after = { ...before };
    const applied = { affinity: 0, trust: 0, respect: 0, familiarity: 0 };
    let clamped = false;
    for (const axis of RELATIONSHIP_AXES) {
      const limited = clamp(sum[axis], -RELATIONSHIP_AXIS_DELTA_MAX, RELATIONSHIP_AXIS_DELTA_MAX);
      const range = axisRange(axis);
      after[axis] = clamp(before[axis] + limited, range.min, range.max);
      applied[axis] = after[axis] - before[axis];
      if (limited !== sum[axis] || after[axis] !== before[axis] + limited) clamped = true;
    }
    return { from, to, before, after, applied, proposed: sum, clamped, reason };
  });
}
