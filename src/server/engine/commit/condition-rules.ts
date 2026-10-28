import { INJURY_NATURAL_RECOVERY_SCENES } from "../../../../config/limits";

// 캐릭터 신체 상태 규칙 (Phase 7-2 명세 §6). 런타임 독립 순수 함수. 상태 변경 적용은 장면 커밋 트랜잭션에서 한다(7-2-2).
// - 통증은 부상 심도와 같은 단계로 본다(NONE·MILD·MODERATE·SEVERE·CRITICAL = 없음·약간 아픔·아픔·매우 아픔·위독).
// - 자연 회복은 진행 장면 수로만 계산한다(현실 시간·브라우저 상태와 무관). 위독은 치료 없이 나아지지 않는다.
// - 치료 효과가 반영된 장면에서는 자연 회복을 함께 적용하지 않는다(중복 방지는 호출자가 treatedThisScene으로 알린다).

export const INJURY_LEVELS = ["NONE", "MILD", "MODERATE", "SEVERE", "CRITICAL"] as const;
export type InjuryLevel = (typeof INJURY_LEVELS)[number];
export const THERMAL_STATES = ["NORMAL", "COLD", "VERY_COLD", "HOT", "VERY_HOT"] as const;
export type ThermalLevel = (typeof THERMAL_STATES)[number];
export const VITAL_STATUSES = ["ALIVE", "DEAD"] as const;
export type VitalLevel = (typeof VITAL_STATUSES)[number];

export const INJURY_LABEL: Record<InjuryLevel, string> = { NONE: "없음", MILD: "약간 아픔", MODERATE: "아픔", SEVERE: "매우 아픔", CRITICAL: "위독" };
export const THERMAL_LABEL: Record<ThermalLevel, string> = { NORMAL: "정상", COLD: "추움", VERY_COLD: "매우 추움", HOT: "더움", VERY_HOT: "매우 더움" };
export const VITAL_LABEL: Record<VitalLevel, string> = { ALIVE: "생존", DEAD: "사망" };

/**
 * 이번 장면(currentSeq) 커밋 때의 자연 회복 결과. 회복하지 않으면 null.
 * lastChangeSeq = 마지막 부상 변화(발생·악화·치료·회복) 장면. 그 뒤 INJURY_NATURAL_RECOVERY_SCENES 장면이 지나면 한 단계 낮아진다.
 */
export function naturalInjuryRecovery(injury: InjuryLevel, lastChangeSeq: number | null, currentSeq: number, treatedThisScene: boolean): InjuryLevel | null {
  const after = INJURY_NATURAL_RECOVERY_SCENES[injury];
  if (after === null || lastChangeSeq === null || treatedThisScene) return null;
  if (currentSeq - lastChangeSeq < after) return null;
  return INJURY_LEVELS[INJURY_LEVELS.indexOf(injury) - 1]!;
}
