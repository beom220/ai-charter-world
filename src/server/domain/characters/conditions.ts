import type { InjuryLevel, ThermalLevel, VitalLevel } from "@/server/engine/commit/condition-rules";

// 캐릭터 신체 상태 조회 모델 (Phase 7-2 명세 §6). 런타임 독립.
// - CharacterCondition 1:1. 행이 없으면(직접 만든 테스트 데이터 등) 정상·부상 없음·생존으로 본다.
// - 사망해도 캐릭터 행은 그대로 남아 슬롯(활성 6명 상한)을 차지한다. deletedAt(소프트 삭제)과 다른 의미다.

export type ConditionView = {
  thermal: ThermalLevel;
  injury: InjuryLevel;
  injuryCause: string | null;
  injurySceneSeq: number | null;
  vital: VitalLevel;
  deathCause: string | null;
  deathSceneSeq: number | null;
  diedAt: Date | null;
};

export const DEFAULT_CONDITION: ConditionView = {
  thermal: "NORMAL",
  injury: "NONE",
  injuryCause: null,
  injurySceneSeq: null,
  vital: "ALIVE",
  deathCause: null,
  deathSceneSeq: null,
  diedAt: null,
};

export const conditionSelect = {
  thermal: true,
  injury: true,
  injuryCause: true,
  injurySceneSeq: true,
  vital: true,
  deathCause: true,
  deathSceneSeq: true,
  diedAt: true,
} as const;

export const toConditionView = (row: ConditionView | null | undefined): ConditionView => row ?? DEFAULT_CONDITION;
