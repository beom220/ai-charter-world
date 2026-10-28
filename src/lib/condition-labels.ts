// 캐릭터 신체 상태 단계·표시 문구 (Phase 7-2-2). 클라이언트·서버 공용.
// 온도 불편: 정상 / 추움(경미·심함·극심) / 더움(…). 고통: 없음 / 고통(경미·심함·극심). 부상: 없음·약간 아픔·아픔·매우 아픔·위독.

export const INJURY_LEVELS = ["NONE", "MILD", "MODERATE", "SEVERE", "CRITICAL"] as const;
export type InjuryLevel = (typeof INJURY_LEVELS)[number];
export const DISCOMFORT_LEVELS = ["NONE", "MILD", "SEVERE", "EXTREME"] as const;
export type DiscomfortLevel = (typeof DISCOMFORT_LEVELS)[number];
export const THERMAL_CAUSES = ["NONE", "COLD", "HEAT"] as const;
export type ThermalCauseValue = (typeof THERMAL_CAUSES)[number];
export const VITAL_STATUSES = ["ALIVE", "DEAD"] as const;
export type VitalLevel = (typeof VITAL_STATUSES)[number];

export const INJURY_LABEL: Record<InjuryLevel, string> = { NONE: "없음", MILD: "약간 아픔", MODERATE: "아픔", SEVERE: "매우 아픔", CRITICAL: "위독" };
export const DISCOMFORT_LABEL: Record<DiscomfortLevel, string> = { NONE: "없음", MILD: "경미", SEVERE: "심함", EXTREME: "극심" };
export const VITAL_LABEL: Record<VitalLevel, string> = { ALIVE: "생존", DEAD: "사망" };

/** 정상 / 추움(경미) / 더움(극심) … */
export function thermalLabel(cause: ThermalCauseValue, level: DiscomfortLevel): string {
  if (cause === "NONE" || level === "NONE") return "정상";
  return `${cause === "COLD" ? "추움" : "더움"}(${DISCOMFORT_LABEL[level]})`;
}

/** 없음 / 고통(경미) … */
export const painLabel = (level: DiscomfortLevel): string => (level === "NONE" ? "없음" : `고통(${DISCOMFORT_LABEL[level]})`);

/** 목록 배지용: 정상이 아닌 항목만 */
export function conditionBadges(c: { thermalCause: ThermalCauseValue; thermalLevel: DiscomfortLevel; painLevel: DiscomfortLevel; injury: InjuryLevel; vital: VitalLevel }): string[] {
  if (c.vital === "DEAD") return ["사망"];
  return [
    c.thermalLevel !== "NONE" ? thermalLabel(c.thermalCause, c.thermalLevel) : null,
    c.painLevel !== "NONE" ? painLabel(c.painLevel) : null,
    c.injury !== "NONE" ? `부상 ${INJURY_LABEL[c.injury]}` : null,
  ].filter((x): x is string => x !== null);
}
