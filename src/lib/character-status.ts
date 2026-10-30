// 캐릭터 상세 상태창의 표시용 변환 (게임형 막대 UI). 클라이언트·서버 공용 순수 함수.
// 저장 값(관계 수치·감정 강도·신체 상태 단계)은 그대로 두고 화면에 보일 막대 값·문구만 계산한다.
// 감정·관계·신체 상태 계산 로직, 프롬프트, DB·세이브 구조와 무관하다.

import { DISCOMFORT_LABEL, INJURY_LABEL, type DiscomfortLevel, type InjuryLevel, type ThermalCauseValue } from "./condition-labels";

/**
 * 공통 양극형 막대 값: 중앙 0, 왼쪽 끝 -100, 오른쪽 끝 +100. 절댓값에 비례해 중앙에서 그 방향으로 채운다.
 * 색은 모두 같고(테마 토큰), 의미는 방향과 text로 구분한다(색에만 의존하지 않음).
 */
export type BarView = { value: number; text: string };

const clampBar = (v: number) => Math.min(100, Math.max(-100, Math.round(v)));

/** 막대 채움 위치: 중앙(50%)에서 음수는 왼쪽, 양수는 오른쪽으로 |value|/2 % 만큼. 0이면 채움 없음(중앙 기준선만) */
export function barFill(value: number): { side: "left" | "right" | null; widthPercent: number } {
  const v = clampBar(value);
  if (v === 0) return { side: null, widthPercent: 0 };
  return { side: v < 0 ? "left" : "right", widthPercent: Math.abs(v) / 2 };
}

// ── 관계 (A → B 한 방향)
// 좋고 나쁨을 나타내는 축(호감·신뢰·존중, 각 -100~100)의 평균을 그대로 막대 값으로 쓴다(이미 -100~100).
// 친밀도(0~100)는 "얼마나 잘 아는가"라서 넣지 않는다. 초기값 0은 "보통"(중앙)이고, 장면마다 축별 최대 ±5씩 변한다.

export const RELATION_STAGES = ["매우 나쁨", "나쁨", "보통", "좋음", "매우 좋음"] as const;
export type RelationStage = (typeof RELATION_STAGES)[number];

export type RelationValues = { affinity: number; trust: number; respect: number; familiarity: number };

const relationScore = (r: RelationValues) => (r.affinity + r.trust + r.respect) / 3;

/** 호감·신뢰·존중 평균(-100~100) → 1~5단계. 경계: ≤-60 매우 나쁨, ≤-20 나쁨, <20 보통, <60 좋음, 그 이상 매우 좋음 */
export function relationStageIndex(r: RelationValues): number {
  const score = relationScore(r);
  if (score <= -60) return 1;
  if (score <= -20) return 2;
  if (score < 20) return 3;
  if (score < 60) return 4;
  return 5;
}

export function relationBar(r: RelationValues): BarView {
  return { value: clampBar(relationScore(r)), text: RELATION_STAGES[relationStageIndex(r) - 1]! };
}

// ── 감정
// 기존 감정 모델(12종 Mood)에는 긍정·부정 구분이 없어 표시용 방향을 여기서 정한다(감정 종류 → 방향, 강도 → 길이).
// 평온·차분은 중립이라 강도와 관계없이 중앙(0)에 둔다. 당황·지침은 불편한 상태라 부정 쪽이다.
// 표정 매핑도 moodVisual 한 곳에 둔다. 나중에 프로필 일러스트 표정 전환은 expression 키로 연결한다(이번에는 이미지 없음).

export type MoodPolarity = -1 | 0 | 1;
export type MoodVisual = { polarity: MoodPolarity; expression: string };
const MOOD_VISUAL: Record<string, MoodVisual> = {
  NEUTRAL: { polarity: 0, expression: "neutral" },
  CALM: { polarity: 0, expression: "calm" },
  HAPPY: { polarity: 1, expression: "smile" },
  EXCITED: { polarity: 1, expression: "excited" },
  HOPEFUL: { polarity: 1, expression: "hopeful" },
  SAD: { polarity: -1, expression: "sad" },
  ANXIOUS: { polarity: -1, expression: "anxious" },
  ANGRY: { polarity: -1, expression: "angry" },
  FEARFUL: { polarity: -1, expression: "fearful" },
  LONELY: { polarity: -1, expression: "lonely" },
  EMBARRASSED: { polarity: -1, expression: "embarrassed" },
  TIRED: { polarity: -1, expression: "tired" },
};

export function moodVisual(mood: string): MoodVisual {
  return MOOD_VISUAL[mood] ?? MOOD_VISUAL.NEUTRAL!;
}

export const INTENSITY_STAGES = ["매우 약함", "약함", "보통", "강함", "매우 강함"] as const;

/** 강도 0~100 → 1~5단계 (0~20, 21~40, 41~60, 61~80, 81~100) */
export function intensityStageIndex(intensity: number): number {
  const v = Math.min(100, Math.max(0, Math.round(intensity)));
  return v <= 20 ? 1 : v <= 40 ? 2 : v <= 60 ? 3 : v <= 80 ? 4 : 5;
}

/** 막대 값 = 감정 방향 × 강도(0~100). 문구는 강도 단계 */
export function intensityBar(mood: string, intensity: number): BarView {
  const v = Math.min(100, Math.max(0, Math.round(intensity)));
  return { value: clampBar(moodVisual(mood).polarity * v), text: INTENSITY_STAGES[intensityStageIndex(intensity) - 1]! };
}

// ── 신체 상태 (기존 단계를 단계 수로 나눈 비율로 채운다. 정밀한 수치를 만들지 않는다)
// 온도: 추위는 왼쪽, 더위는 오른쪽. 고통·부상은 음수가 없어 중앙에서 오른쪽으로만 늘어난다.

const DISCOMFORT_STEP: Record<DiscomfortLevel, number> = { NONE: 0, MILD: 1, SEVERE: 2, EXTREME: 3 };
const INJURY_STEP: Record<InjuryLevel, number> = { NONE: 0, MILD: 1, MODERATE: 2, SEVERE: 3, CRITICAL: 4 };
const stepValue = (step: number, steps: number) => Math.round((step / steps) * 100);

/** 온도 불편: 정상(0) / 추위 -33·-67·-100 / 더위 +33·+67·+100 (경미·심함·극심). label은 원인(thermalCause)에서 정한다 */
export function thermalBar(cause: ThermalCauseValue, level: DiscomfortLevel): BarView & { cause: ThermalCauseValue; label: string } {
  const step = cause === "NONE" ? 0 : DISCOMFORT_STEP[level];
  if (step === 0) return { value: 0, text: "정상", cause: "NONE", label: "체감 온도" };
  const magnitude = stepValue(step, 3);
  return { value: cause === "COLD" ? -magnitude : magnitude, text: DISCOMFORT_LABEL[level], cause, label: cause === "COLD" ? "추위" : "더위" };
}

/** 고통: 없음(0) / 경미 33·심함 67·극심 100 */
export function painBar(level: DiscomfortLevel): BarView {
  return { value: stepValue(DISCOMFORT_STEP[level], 3), text: DISCOMFORT_LABEL[level] };
}

/** 부상: 없음(0) / 약간 아픔 25·아픔 50·매우 아픔 75·위독 100 */
export function injuryBar(level: InjuryLevel): BarView {
  return { value: stepValue(INJURY_STEP[level], 4), text: INJURY_LABEL[level] };
}

export type ConditionInput = {
  thermalCause: ThermalCauseValue;
  thermalLevel: DiscomfortLevel;
  painLevel: DiscomfortLevel;
  painCause: string | null;
  injury: InjuryLevel;
  injuryCause: string | null;
};
export type AbnormalCondition = { key: "thermal" | "pain" | "injury"; label: string; bar: BarView; detail: string | null };

/** 정상이 아닌 신체 항목만 (추위·더위 → 고통 → 부상 순). 모두 정상이면 빈 배열이라 화면은 신체 영역을 그리지 않는다. 사망은 따로 보인다 */
export function abnormalConditions(c: ConditionInput): AbnormalCondition[] {
  const out: AbnormalCondition[] = [];
  const thermal = thermalBar(c.thermalCause, c.thermalLevel);
  if (thermal.value !== 0) out.push({ key: "thermal", label: thermal.label, bar: thermal, detail: null });
  const pain = painBar(c.painLevel);
  if (pain.value !== 0) out.push({ key: "pain", label: "고통", bar: pain, detail: c.painCause });
  const injury = injuryBar(c.injury);
  if (injury.value !== 0) out.push({ key: "injury", label: "부상", bar: injury, detail: c.injuryCause });
  return out;
}
