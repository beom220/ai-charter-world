// 캐릭터 상세 상태창의 표시용 변환 (게임형 막대 UI). 클라이언트·서버 공용 순수 함수.
// 저장 값(관계 수치·감정 강도·신체 상태 단계)은 그대로 두고 화면에 보일 단계·문구·색만 계산한다.
// 감정·관계·신체 상태 계산 로직, 프롬프트, DB·세이브 구조와 무관하다.

import { DISCOMFORT_LABEL, INJURY_LABEL, type DiscomfortLevel, type InjuryLevel, type ThermalCauseValue } from "./condition-labels";

/** 공통 막대 표시 값: segments칸 중 filled칸을 color로 채운다. 색에만 의존하지 않도록 text를 함께 보인다 */
export type StatusBarView = { segments: number; filled: number; color: string; text: string };

// ── 관계 (A → B 한 방향)
// 기존 단계 정의가 없어 표시용 단계를 정한다. 좋고 나쁨을 나타내는 축(호감·신뢰·존중, 각 -100~100)의 평균으로 판정한다.
// 친밀도(0~100)는 "얼마나 잘 아는가"라서 좋고 나쁨에 넣지 않는다. 초기값 0은 "보통"이고, 장면마다 축별 최대 ±5씩 변한다.

export const RELATION_STAGES = ["매우 나쁨", "나쁨", "보통", "좋음", "매우 좋음"] as const;
export type RelationStage = (typeof RELATION_STAGES)[number];
/** 단계별 막대 색: 나쁨은 차가운 회청색, 보통은 아이보리 회색, 좋음은 테마 핑크 */
const RELATION_COLORS = ["#6F86A8", "#9DB0C9", "#CFCAB9", "#E8A9B6", "#E57694"] as const;

export type RelationValues = { affinity: number; trust: number; respect: number; familiarity: number };

/** 호감·신뢰·존중 평균(-100~100) → 1~5단계. 경계: ≤-60 매우 나쁨, ≤-20 나쁨, <20 보통, <60 좋음, 그 이상 매우 좋음 */
export function relationStageIndex(r: RelationValues): number {
  const score = (r.affinity + r.trust + r.respect) / 3;
  if (score <= -60) return 1;
  if (score <= -20) return 2;
  if (score < 20) return 3;
  if (score < 60) return 4;
  return 5;
}

export function relationBar(r: RelationValues): StatusBarView {
  const stage = relationStageIndex(r);
  return { segments: RELATION_STAGES.length, filled: stage, color: RELATION_COLORS[stage - 1]!, text: RELATION_STAGES[stage - 1]! };
}

// ── 감정
// 표정 매핑은 moodVisual 한 곳에 둔다. 나중에 프로필 일러스트 표정 전환은 expression 키로 연결한다(이번에는 이미지 없음).
// 화면에는 이모지·아이콘 없이 감정 이름과 막대 색으로만 보인다.

export type MoodVisual = { color: string; expression: string };
const MOOD_VISUAL: Record<string, MoodVisual> = {
  NEUTRAL: { color: "#CFCAB9", expression: "neutral" },
  HAPPY: { color: "#F2B8C6", expression: "smile" },
  EXCITED: { color: "#F59AB0", expression: "excited" },
  CALM: { color: "#A9D4C2", expression: "calm" },
  SAD: { color: "#A8BCD8", expression: "sad" },
  ANXIOUS: { color: "#C7B3DE", expression: "anxious" },
  ANGRY: { color: "#E8868F", expression: "angry" },
  FEARFUL: { color: "#9FA6C9", expression: "fearful" },
  EMBARRASSED: { color: "#F4A99A", expression: "embarrassed" },
  LONELY: { color: "#B9C3D6", expression: "lonely" },
  HOPEFUL: { color: "#F3C98B", expression: "hopeful" },
  TIRED: { color: "#C9C2B4", expression: "tired" },
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

export function intensityBar(mood: string, intensity: number): StatusBarView {
  const stage = intensityStageIndex(intensity);
  return { segments: INTENSITY_STAGES.length, filled: stage, color: moodVisual(mood).color, text: INTENSITY_STAGES[stage - 1]! };
}

// ── 신체 상태 (기존 단계를 그대로 칸으로 채운다. 정밀한 수치를 만들지 않는다)

const DISCOMFORT_STEP: Record<DiscomfortLevel, number> = { NONE: 0, MILD: 1, SEVERE: 2, EXTREME: 3 };
const INJURY_STEP: Record<InjuryLevel, number> = { NONE: 0, MILD: 1, MODERATE: 2, SEVERE: 3, CRITICAL: 4 };
/** 고통·부상: 단계가 오를수록 노랑 → 주황 → 빨강 (부드러운 톤) */
const SEVERITY_COLORS = ["#F3C98B", "#F2A07B", "#E8737F", "#C9465A"] as const;
const COLD_COLORS = ["#A9CBEA", "#7FAEDB", "#5A8CC7"] as const;
const HEAT_COLORS = ["#F3C98B", "#F2A07B", "#E8737F"] as const;
const EMPTY_COLOR = "transparent";

/** 온도 불편: 정상(빈 막대) / 추위·더위(thermalCause) 경미·심함·극심(thermalLevel) 3칸. label은 원인에서 정한다 */
export function thermalBar(cause: ThermalCauseValue, level: DiscomfortLevel): StatusBarView & { cause: ThermalCauseValue; label: string } {
  const step = cause === "NONE" ? 0 : DISCOMFORT_STEP[level];
  if (step === 0) return { segments: 3, filled: 0, color: EMPTY_COLOR, text: "정상", cause: "NONE", label: "체감 온도" };
  const colors = cause === "COLD" ? COLD_COLORS : HEAT_COLORS;
  return { segments: 3, filled: step, color: colors[step - 1]!, text: DISCOMFORT_LABEL[level], cause, label: cause === "COLD" ? "추위" : "더위" };
}

/** 고통: 없음(빈 막대) / 경미·심함·극심 (3칸) */
export function painBar(level: DiscomfortLevel): StatusBarView {
  const step = DISCOMFORT_STEP[level];
  return { segments: 3, filled: step, color: step === 0 ? EMPTY_COLOR : SEVERITY_COLORS[step - 1]!, text: DISCOMFORT_LABEL[level] };
}

/** 부상: 없음(빈 막대) / 약간 아픔·아픔·매우 아픔·위독 (4칸) */
export function injuryBar(level: InjuryLevel): StatusBarView {
  const step = INJURY_STEP[level];
  return { segments: 4, filled: step, color: step === 0 ? EMPTY_COLOR : SEVERITY_COLORS[step - 1]!, text: INJURY_LABEL[level] };
}

export type ConditionInput = {
  thermalCause: ThermalCauseValue;
  thermalLevel: DiscomfortLevel;
  painLevel: DiscomfortLevel;
  painCause: string | null;
  injury: InjuryLevel;
  injuryCause: string | null;
};
export type AbnormalCondition = { key: "thermal" | "pain" | "injury"; label: string; bar: StatusBarView; detail: string | null };

/** 정상이 아닌 신체 항목만 (추위·더위 → 고통 → 부상 순). 모두 정상이면 빈 배열이라 화면은 신체 영역을 그리지 않는다. 사망은 따로 보인다 */
export function abnormalConditions(c: ConditionInput): AbnormalCondition[] {
  const out: AbnormalCondition[] = [];
  const thermal = thermalBar(c.thermalCause, c.thermalLevel);
  if (thermal.filled > 0) out.push({ key: "thermal", label: thermal.label, bar: thermal, detail: null });
  const pain = painBar(c.painLevel);
  if (pain.filled > 0) out.push({ key: "pain", label: "고통", bar: pain, detail: c.painCause });
  const injury = injuryBar(c.injury);
  if (injury.filled > 0) out.push({ key: "injury", label: "부상", bar: injury, detail: c.injuryCause });
  return out;
}
