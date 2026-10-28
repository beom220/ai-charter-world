import type { DiscomfortLevel, InjuryLevel, ThermalCauseValue, VitalLevel } from "@/server/engine/commit/condition-rules";

// 캐릭터 신체 상태 조회 모델 (Phase 7-2 명세 §6, 7-2-2 재구성). 런타임 독립.
// - CharacterCondition 1:1. 행이 없으면(직접 만든 테스트 데이터 등) 정상·고통 없음·부상 없음·생존으로 본다.
// - 온도 불편은 원인(추위·더위)과 단계(경미·심함·극심), 고통은 부상과 독립된 단계다. *Seconds는 월드 누적 초.
// - 사망해도 캐릭터 행은 그대로 남아 슬롯(활성 6명 상한)을 차지한다. deletedAt(소프트 삭제)과 다른 의미다.

export type ConditionView = {
  thermalCause: ThermalCauseValue;
  thermalLevel: DiscomfortLevel;
  painLevel: DiscomfortLevel;
  painCause: string | null;
  injury: InjuryLevel;
  injuryCause: string | null;
  injurySceneSeq: number | null;
  extremeSinceSeconds: number | null;
  vital: VitalLevel;
  deathCause: string | null;
  deathSceneSeq: number | null;
  deathWorldSeconds: number | null;
  diedAt: Date | null;
};

export const DEFAULT_CONDITION: ConditionView = {
  thermalCause: "NONE",
  thermalLevel: "NONE",
  painLevel: "NONE",
  painCause: null,
  injury: "NONE",
  injuryCause: null,
  injurySceneSeq: null,
  extremeSinceSeconds: null,
  vital: "ALIVE",
  deathCause: null,
  deathSceneSeq: null,
  deathWorldSeconds: null,
  diedAt: null,
};

export const conditionSelect = {
  thermalCause: true,
  thermalLevel: true,
  painLevel: true,
  painCause: true,
  injury: true,
  injuryCause: true,
  injurySceneSeq: true,
  extremeSinceSeconds: true,
  vital: true,
  deathCause: true,
  deathSceneSeq: true,
  deathWorldSeconds: true,
  diedAt: true,
} as const satisfies Record<keyof ConditionView, true>;

export const toConditionView = (row: ConditionView | null | undefined): ConditionView => row ?? DEFAULT_CONDITION;
