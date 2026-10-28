import {
  CONDITION_MAX_WORSEN_STEPS_PER_SCENE,
  EXTREME_LETHAL_WORLD_SECONDS,
  EXTREME_LIFE_RISK_WORLD_SECONDS,
  INJURY_NATURAL_RECOVERY_WORLD_SECONDS,
  PAIN_NATURAL_EASE_WORLD_SECONDS,
} from "../../../../config/limits";

// 캐릭터 신체 상태 규칙 (Phase 7-2-2). 런타임 독립 순수 함수. 장면 커밋 트랜잭션이 결과만 저장한다.
// - 온도 불편: 원인(추위·더위) × 단계(경미·심함·극심). 추위와 더위를 함께 갖지 않는다. 시간만으로는 바뀌지 않고 장면 결과로만 바뀐다.
// - 고통: 부상과 독립된 단계(경미·심함·극심). 부상은 기존 5단계(약간 아픔·아픔·매우 아픔·위독)를 그대로 쓴다.
// - 모델 제안은 검증한다: 한 장면에서 한 단계씩만 악화(고강도 사건 진행 중이면 두 단계), 원인 없는 부상 거부, 위독은 고강도 사건이나
//   이미 매우 아픔일 때만, 개선(부상·고통)은 실제 치료 결과(treatment)가 있을 때만, 온도 개선은 한 단계씩.
// - 자연 회복·고통 완화는 월드 시간 기준(장면 수로 두 번 세지 않는다). 치료가 반영된 장면·부상이 악화된 장면에서는 자연 회복을 하지 않는다.
// - 극심(온도 극심·고통 극심·위독)이 이어진 월드 시간: 12시간 이상이면 생명 위험(제안된 사망 수용 가능), 48시간 이상이면 서버가 사망 확정.
//   극심이 풀리면 누적이 사라진다(치료·대피로 회복 가능). 극심 진입 즉시·무작위 즉사는 없다.
// - 제안된 사망은 생명 위험이거나, 고강도 사건 진행 중 이번 장면에서 위독이 된 치명적 결과일 때만 받아들인다. 사망 뒤에는 아무것도 바꾸지 않는다.

import {
  DISCOMFORT_LEVELS,
  INJURY_LEVELS,
  type DiscomfortLevel,
  type InjuryLevel,
  type ThermalCauseValue,
  type VitalLevel,
} from "@/lib/condition-labels";

export { DISCOMFORT_LABEL, INJURY_LABEL, painLabel, thermalLabel, VITAL_LABEL } from "@/lib/condition-labels";
export type { DiscomfortLevel, InjuryLevel, ThermalCauseValue, VitalLevel };

export type ConditionState = {
  thermalCause: ThermalCauseValue;
  thermalLevel: DiscomfortLevel;
  thermalSinceSeconds: number | null;
  painLevel: DiscomfortLevel;
  painCause: string | null;
  painSinceSeconds: number | null;
  injury: InjuryLevel;
  injuryCause: string | null;
  injurySceneSeq: number | null;
  injuryUpdatedAtSeconds: number | null;
  extremeSinceSeconds: number | null;
  vital: VitalLevel;
  deathCause: string | null;
  deathSceneSeq: number | null;
  deathWorldSeconds: number | null;
};

/** 신체 상태 행이 없을 때의 기본값 (정상·고통 없음·부상 없음·생존) */
export const DEFAULT_CONDITION_STATE: ConditionState = {
  thermalCause: "NONE",
  thermalLevel: "NONE",
  thermalSinceSeconds: null,
  painLevel: "NONE",
  painCause: null,
  painSinceSeconds: null,
  injury: "NONE",
  injuryCause: null,
  injurySceneSeq: null,
  injuryUpdatedAtSeconds: null,
  extremeSinceSeconds: null,
  vital: "ALIVE",
  deathCause: null,
  deathSceneSeq: null,
  deathWorldSeconds: null,
};

/** 검증 전 모델 제안 (별칭은 호출자가 캐릭터로 되돌린다) */
export type ConditionProposal = {
  thermal: { cause: ThermalCauseValue; level: DiscomfortLevel } | null;
  pain: { level: DiscomfortLevel; cause: string | null } | null;
  injury: { level: InjuryLevel; cause: string } | null;
  /** 장면에서 실제로 수행된 치료·응급처치·진통 (계획·대사만이면 null) */
  treatment: string | null;
  death: { cause: string } | null;
};

export type ConditionContext = {
  nowSeconds: number;
  sceneSeq: number;
  /** 이번 장면에 고강도(HIGH) 사건이 진행 중인가 (새로 시작한 사건 포함) */
  highIntensityEvent: boolean;
};

export type ConditionChangeRecord = { kind: "THERMAL" | "INJURY" | "TREATMENT" | "RECOVERY" | "DEATH"; from: string; to: string; reason: string | null };

const rank = <T extends string>(levels: readonly T[], v: T) => levels.indexOf(v);
const step = <T extends string>(levels: readonly T[], v: T, by: number): T => levels[Math.min(levels.length - 1, Math.max(0, rank(levels, v) + by))]!;
const text = (s: string | null | undefined) => (s && s.trim() ? s.trim().slice(0, 200) : null);

/** 부상이 남기는 최소 고통 (자연 완화의 하한, 새 부상의 최소 고통) */
const PAIN_FLOOR: Record<InjuryLevel, DiscomfortLevel> = { NONE: "NONE", MILD: "NONE", MODERATE: "MILD", SEVERE: "SEVERE", CRITICAL: "SEVERE" };

const isExtreme = (c: ConditionState) => c.thermalLevel === "EXTREME" || c.painLevel === "EXTREME" || c.injury === "CRITICAL";

/** 생명 위험: 극심이 EXTREME_LIFE_RISK_WORLD_SECONDS 이상 이어짐 */
export const lifeAtRisk = (c: ConditionState, nowSeconds: number): boolean =>
  c.vital === "ALIVE" && c.extremeSinceSeconds !== null && nowSeconds - c.extremeSinceSeconds >= EXTREME_LIFE_RISK_WORLD_SECONDS;

function extremeCause(c: ConditionState): string {
  if (c.injury === "CRITICAL") return `위독한 부상이 오래 이어짐${c.injuryCause ? ` (${c.injuryCause})` : ""}`;
  if (c.thermalLevel === "EXTREME") return c.thermalCause === "COLD" ? "극심한 추위가 오래 이어짐" : "극심한 더위가 오래 이어짐";
  return `극심한 고통이 오래 이어짐${c.painCause ? ` (${c.painCause})` : ""}`;
}

/**
 * 한 캐릭터의 이번 장면 커밋 결과. proposal은 참가자에게만 있다(비참가자는 null: 자연 변화·극심 지속·사망 판정만).
 * 순서(결정적): 치료 → 부상 악화 → 고통 → 온도 → 자연 회복 → 극심 추적 → 사망(제안 검증 또는 극심 지속 확정).
 */
export function planConditionChange(before: ConditionState, proposal: ConditionProposal | null, ctx: ConditionContext): { next: ConditionState; changes: ConditionChangeRecord[] } {
  if (before.vital === "DEAD") return { next: before, changes: [] };
  const c: ConditionState = { ...before };
  const changes: ConditionChangeRecord[] = [];
  const now = ctx.nowSeconds;
  const worsenSteps = CONDITION_MAX_WORSEN_STEPS_PER_SCENE + (ctx.highIntensityEvent ? 1 : 0);

  // 1) 치료: 실제 수행된 결과가 있을 때만 부상·고통을 한 단계씩 낮춘다
  const treatment = text(proposal?.treatment);
  const treated = treatment !== null && (c.injury !== "NONE" || c.painLevel !== "NONE");
  if (treated) {
    if (c.injury !== "NONE") {
      const to = step(INJURY_LEVELS, c.injury, -1);
      changes.push({ kind: "TREATMENT", from: c.injury, to, reason: treatment });
      c.injury = to;
      c.injuryUpdatedAtSeconds = now;
      if (to === "NONE") c.injuryCause = null;
    }
    if (c.painLevel !== "NONE") {
      const to = step(DISCOMFORT_LEVELS, c.painLevel, -1);
      changes.push({ kind: "TREATMENT", from: `PAIN_${c.painLevel}`, to: `PAIN_${to}`, reason: treatment });
      c.painLevel = to;
      c.painSinceSeconds = to === "NONE" ? null : now;
      if (to === "NONE") c.painCause = null;
    }
  }

  // 2) 부상 악화: 원인이 있어야 하고, 한 장면 상한, 위독은 고강도 사건이나 이미 매우 아픔일 때만. 치료한 장면에서는 받지 않는다
  let injuredNow = false;
  const injuryCause = text(proposal?.injury?.cause);
  if (proposal?.injury && injuryCause && !treated && rank(INJURY_LEVELS, proposal.injury.level) > rank(INJURY_LEVELS, c.injury)) {
    let to = step(INJURY_LEVELS, c.injury, Math.min(worsenSteps, rank(INJURY_LEVELS, proposal.injury.level) - rank(INJURY_LEVELS, c.injury)));
    if (to === "CRITICAL" && !ctx.highIntensityEvent && c.injury !== "SEVERE") to = "SEVERE";
    if (to !== c.injury) {
      changes.push({ kind: "INJURY", from: c.injury, to, reason: injuryCause });
      if (c.injury === "NONE") c.injurySceneSeq = ctx.sceneSeq;
      c.injury = to;
      c.injuryCause = injuryCause;
      c.injuryUpdatedAtSeconds = now;
      injuredNow = true;
      const floor = PAIN_FLOOR[to];
      if (rank(DISCOMFORT_LEVELS, c.painLevel) < rank(DISCOMFORT_LEVELS, floor)) {
        changes.push({ kind: "INJURY", from: `PAIN_${c.painLevel}`, to: `PAIN_${floor}`, reason: injuryCause });
        c.painLevel = floor;
        c.painCause = injuryCause;
        c.painSinceSeconds = now;
      }
    }
  }

  // 3) 고통 제안: 악화는 한 장면 상한(부상이 생긴 장면은 +1), 완화는 치료가 있을 때만(치료로 이미 한 단계 낮췄으면 더 낮추지 않음)
  if (proposal?.pain && !treated) {
    const diff = rank(DISCOMFORT_LEVELS, proposal.pain.level) - rank(DISCOMFORT_LEVELS, c.painLevel);
    const cause = text(proposal.pain.cause) ?? c.painCause;
    if (diff > 0 && cause) {
      const to = step(DISCOMFORT_LEVELS, c.painLevel, Math.min(diff, worsenSteps + (injuredNow ? 1 : 0)));
      changes.push({ kind: "INJURY", from: `PAIN_${c.painLevel}`, to: `PAIN_${to}`, reason: cause });
      c.painLevel = to;
      c.painCause = cause;
      c.painSinceSeconds = now;
    }
  }

  // 4) 온도: 원인 전환은 경미 이하에서만, 악화는 한 장면 상한, 개선(대피·난방·냉방 등 장면 결과)은 한 단계씩
  if (proposal?.thermal) {
    const target = proposal.thermal.cause === "NONE" ? { cause: "NONE" as const, level: "NONE" as const } : proposal.thermal;
    let cause = c.thermalCause;
    let level = c.thermalLevel;
    if (target.cause !== "NONE" && target.level !== "NONE" && c.thermalCause !== "NONE" && target.cause !== c.thermalCause) {
      // 반대 원인: 현재 단계가 경미 이하일 때만 바뀌고, 새 원인은 경미에서 시작한다
      if (rank(DISCOMFORT_LEVELS, c.thermalLevel) <= rank(DISCOMFORT_LEVELS, "MILD")) [cause, level] = [target.cause, "MILD"];
    } else if (target.cause === "NONE" || target.level === "NONE" || rank(DISCOMFORT_LEVELS, target.level) < rank(DISCOMFORT_LEVELS, c.thermalLevel)) {
      level = step(DISCOMFORT_LEVELS, c.thermalLevel, -1);
      if (level === "NONE") cause = "NONE";
    } else if (rank(DISCOMFORT_LEVELS, target.level) > rank(DISCOMFORT_LEVELS, c.thermalLevel)) {
      cause = target.cause;
      level = step(DISCOMFORT_LEVELS, c.thermalLevel, Math.min(worsenSteps, rank(DISCOMFORT_LEVELS, target.level) - rank(DISCOMFORT_LEVELS, c.thermalLevel)));
    }
    if (cause !== c.thermalCause || level !== c.thermalLevel) {
      changes.push({ kind: "THERMAL", from: `${c.thermalCause}_${c.thermalLevel}`, to: `${cause}_${level}`, reason: null });
      c.thermalCause = cause;
      c.thermalLevel = level;
      c.thermalSinceSeconds = level === "NONE" ? null : now;
    }
  }

  // 5) 자연 회복·고통 완화 (월드 시간). 치료한 장면·악화한 장면은 제외 → 같은 회복을 두 번 적용하지 않는다
  if (!treated && !injuredNow) {
    const after = INJURY_NATURAL_RECOVERY_WORLD_SECONDS[c.injury];
    if (after !== null && c.injuryUpdatedAtSeconds !== null && now - c.injuryUpdatedAtSeconds >= after) {
      const to = step(INJURY_LEVELS, c.injury, -1);
      changes.push({ kind: "RECOVERY", from: c.injury, to, reason: null });
      c.injury = to;
      c.injuryUpdatedAtSeconds = now;
      if (to === "NONE") c.injuryCause = null;
    }
    const floor = PAIN_FLOOR[c.injury];
    if (rank(DISCOMFORT_LEVELS, c.painLevel) > rank(DISCOMFORT_LEVELS, floor) && c.painSinceSeconds !== null && now - c.painSinceSeconds >= PAIN_NATURAL_EASE_WORLD_SECONDS) {
      const to = step(DISCOMFORT_LEVELS, c.painLevel, -1);
      changes.push({ kind: "RECOVERY", from: `PAIN_${c.painLevel}`, to: `PAIN_${to}`, reason: null });
      c.painLevel = to;
      c.painSinceSeconds = to === "NONE" ? null : now;
      if (to === "NONE") c.painCause = null;
    }
  }

  // 6) 극심 지속 추적: 극심이 시작된 월드 시각, 풀리면 NULL (누적 해제)
  if (isExtreme(c)) c.extremeSinceSeconds ??= now;
  else c.extremeSinceSeconds = null;

  // 7) 사망: 극심이 오래 이어지면 서버가 확정, 제안된 사망은 생명 위험이거나 고강도 사건 중 이번 장면에서 위독이 된 경우만
  const lethal = c.extremeSinceSeconds !== null && now - c.extremeSinceSeconds >= EXTREME_LETHAL_WORLD_SECONDS;
  const proposedDeath = text(proposal?.death?.cause);
  const fatalScene = injuredNow && c.injury === "CRITICAL" && ctx.highIntensityEvent;
  const cause = lethal ? extremeCause(c) : proposedDeath && (lifeAtRisk(c, now) || fatalScene) ? proposedDeath : null;
  if (cause) {
    changes.push({ kind: "DEATH", from: "ALIVE", to: "DEAD", reason: cause });
    c.vital = "DEAD";
    c.deathCause = cause;
    c.deathSceneSeq = ctx.sceneSeq;
    c.deathWorldSeconds = now;
  }
  return { next: c, changes };
}
