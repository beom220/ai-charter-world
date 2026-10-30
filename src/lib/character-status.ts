// 캐릭터 상세 상태창의 표시용 변환 (게임형 상태창). 클라이언트·서버 공용 순수 함수.
// 저장 값(관계 수치·감정 강도·신체 상태 단계)은 그대로 두고 화면에 보일 막대 채움·단계 문구·점수·색 톤만 계산한다.
// 막대는 0에서 최대치까지 왼쪽 → 오른쪽으로 채우는 일반 막대다. 감정 강도(0~100)는 실제 값 비율, 신체 상태는 단계형이라 칸(단계 수) 단위로 채운다.
// 감정·관계·신체 상태 계산 로직, 프롬프트, DB·세이브 구조와 무관하다.

import { DISCOMFORT_LABEL, INJURY_LABEL, type DiscomfortLevel, type InjuryLevel, type ThermalCauseValue } from "./condition-labels";

/** 색 톤: 긍정(로즈 핑크)·부정(블루그레이)·중립(그레이). 의미는 문구로도 함께 보인다(색에만 의존하지 않음) */
export type StatusTone = "positive" | "negative" | "neutral";

// ── 관계 (A → B 한 방향)
// 좋고 나쁨을 나타내는 축(호감·신뢰·존중, 각 -100~100)의 평균이 관계 점수다(반올림한 정수로 보인다).
// 친밀도(0~100)는 "얼마나 잘 아는가"라서 넣지 않는다. 초기값 0은 "보통"이고, 장면마다 축별 최대 ±5씩 변한다.

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

export type RelationView = { stage: RelationStage; score: number; tone: StatusTone };

/** 단계(판정은 반올림 전 평균 기준)·점수(반올림 평균)·톤(나쁨 이하 부정, 보통 중립, 좋음 이상 긍정) */
export function relationView(r: RelationValues): RelationView {
  const index = relationStageIndex(r);
  return { stage: RELATION_STAGES[index - 1]!, score: Math.round(relationScore(r)) || 0, tone: index <= 2 ? "negative" : index === 3 ? "neutral" : "positive" };
}

/** +82 / 0 / -34 */
export const formatScore = (score: number) => (score > 0 ? `+${score}` : String(score));

// ── 감정
// 기존 감정 모델(12종 Mood)에는 긍정·부정 구분이 없어 표시용 방향을 여기서 정한다(감정 종류 → 색 톤).
// 평온·차분은 중립. 당황·지침은 불편한 상태라 부정이다. 감정에는 점수를 보이지 않고 강도 단계만 보인다.
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

// ── 막대 색 단계 (감정·신체 공통 5단계 로즈 핑크, 1 가장 연함 ~ 5 가장 진함, 0은 채움 없음)
// 색 값은 globals.css의 --intensity-1~5(막대 채움)·--intensity-text-1~5(문구, 흰 바탕 대비 4.5:1 이상) 토큰이다.
// 감정·신체 종류와 무관하게 강도만으로 정한다. 길이 계산·단계 판정과 독립이다.

export type IntensityLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** 감정 강도 0~100 → 색 단계. 0이면 채움 없음, 그 밖은 강도 5단계(1~20·21~40·41~60·61~80·81~100)와 같다 */
export function emotionColorLevel(intensity: number): IntensityLevel {
  return Math.round(intensity) <= 0 ? 0 : (intensityStageIndex(intensity) as IntensityLevel);
}

/** 막대 채움은 실제 강도(0~100), 문구는 강도 단계, 톤은 감정 방향, level은 막대 색 단계 */
export function emotionView(mood: string, intensity: number): { value: number; text: string; tone: StatusTone; level: IntensityLevel } {
  const polarity = moodVisual(mood).polarity;
  return {
    value: Math.min(100, Math.max(0, Math.round(intensity))),
    level: emotionColorLevel(intensity),
    text: INTENSITY_STAGES[intensityStageIndex(intensity) - 1]!,
    tone: polarity > 0 ? "positive" : polarity < 0 ? "negative" : "neutral",
  };
}

// ── 신체 상태 (기존 단계 문구 그대로. 점수를 만들지 않고 단계/단계 수만큼 칸을 채운다)

const DISCOMFORT_STEP: Record<DiscomfortLevel, number> = { NONE: 0, MILD: 1, SEVERE: 2, EXTREME: 3 };
const INJURY_STEP: Record<InjuryLevel, number> = { NONE: 0, MILD: 1, MODERATE: 2, SEVERE: 3, CRITICAL: 4 };
/** 신체 단계 → 막대 색 단계. 추위·더위·고통 경미·심함·극심 = 2·4·5, 부상 1~4단계 = 1·3·4·5 */
const DISCOMFORT_COLOR: Record<DiscomfortLevel, IntensityLevel> = { NONE: 0, MILD: 2, SEVERE: 4, EXTREME: 5 };
const INJURY_COLOR: Record<InjuryLevel, IntensityLevel> = { NONE: 0, MILD: 1, MODERATE: 3, SEVERE: 4, CRITICAL: 5 };

export type ConditionInput = {
  thermalCause: ThermalCauseValue;
  thermalLevel: DiscomfortLevel;
  painLevel: DiscomfortLevel;
  painCause: string | null;
  injury: InjuryLevel;
  injuryCause: string | null;
};
export type AbnormalCondition = { key: "thermal" | "pain" | "injury"; label: string; text: string; step: number; steps: number; level: IntensityLevel; detail: string | null };

/**
 * 정상이 아닌 신체 항목만 (추위·더위 → 고통 → 부상 순). 모두 정상이면 빈 배열이라 화면은 신체 영역을 그리지 않는다. 사망은 따로 보인다.
 * 온도는 "온도 불편감" 대신 원인(thermalCause)에 따라 "추위"/"더위"로 보인다.
 */
export function abnormalConditions(c: ConditionInput): AbnormalCondition[] {
  const out: AbnormalCondition[] = [];
  if (c.thermalCause !== "NONE" && c.thermalLevel !== "NONE") {
    const label = c.thermalCause === "COLD" ? "추위" : "더위";
    out.push({ key: "thermal", label, text: DISCOMFORT_LABEL[c.thermalLevel], step: DISCOMFORT_STEP[c.thermalLevel], steps: 3, level: DISCOMFORT_COLOR[c.thermalLevel], detail: null });
  }
  if (c.painLevel !== "NONE") {
    out.push({ key: "pain", label: "고통", text: DISCOMFORT_LABEL[c.painLevel], step: DISCOMFORT_STEP[c.painLevel], steps: 3, level: DISCOMFORT_COLOR[c.painLevel], detail: c.painCause });
  }
  if (c.injury !== "NONE") {
    out.push({ key: "injury", label: "부상", text: INJURY_LABEL[c.injury], step: INJURY_STEP[c.injury], steps: 4, level: INJURY_COLOR[c.injury], detail: c.injuryCause });
  }
  return out;
}
