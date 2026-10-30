// 캐릭터 상세 상태창의 표시용 변환 (텍스트 중심 게임형 정보 UI). 클라이언트·서버 공용 순수 함수.
// 저장 값(관계 수치·감정 강도·신체 상태 단계)은 그대로 두고 화면에 보일 단계 문구·점수·색 톤만 계산한다.
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

/** 문구는 강도 단계, 톤은 감정 방향 */
export function emotionView(mood: string, intensity: number): { text: string; tone: StatusTone } {
  const polarity = moodVisual(mood).polarity;
  return { text: INTENSITY_STAGES[intensityStageIndex(intensity) - 1]!, tone: polarity > 0 ? "positive" : polarity < 0 ? "negative" : "neutral" };
}

// ── 신체 상태 (기존 단계 문구 그대로. 점수를 만들지 않는다)

export type ConditionInput = {
  thermalCause: ThermalCauseValue;
  thermalLevel: DiscomfortLevel;
  painLevel: DiscomfortLevel;
  painCause: string | null;
  injury: InjuryLevel;
  injuryCause: string | null;
};
export type AbnormalCondition = { key: "thermal" | "pain" | "injury"; label: string; text: string; detail: string | null };

/**
 * 정상이 아닌 신체 항목만 (추위·더위 → 고통 → 부상 순). 모두 정상이면 빈 배열이라 화면은 신체 영역을 그리지 않는다. 사망은 따로 보인다.
 * 온도는 "온도 불편감" 대신 원인(thermalCause)에 따라 "추위"/"더위"로 보인다.
 */
export function abnormalConditions(c: ConditionInput): AbnormalCondition[] {
  const out: AbnormalCondition[] = [];
  if (c.thermalCause !== "NONE" && c.thermalLevel !== "NONE") {
    out.push({ key: "thermal", label: c.thermalCause === "COLD" ? "추위" : "더위", text: DISCOMFORT_LABEL[c.thermalLevel], detail: null });
  }
  if (c.painLevel !== "NONE") out.push({ key: "pain", label: "고통", text: DISCOMFORT_LABEL[c.painLevel], detail: c.painCause });
  if (c.injury !== "NONE") out.push({ key: "injury", label: "부상", text: INJURY_LABEL[c.injury], detail: c.injuryCause });
  return out;
}
