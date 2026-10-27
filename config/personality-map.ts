// 성격 태그 분류표와 태그 → Big Five 매핑 (PRD FR-04 "매핑 정책 명시", architecture.md §13).
// 정책: 각 축은 기본값 50에서 시작해 선택한 태그의 가중치를 더한 뒤 0~100으로 clamp한다.
// 클라이언트(태그 선택 UI)와 서버(수치 계산)가 함께 쓰므로 서버 모듈을 import하지 않는다.

export type BigFiveAxis = "extraversion" | "agreeableness" | "conscientiousness" | "emotionalStability" | "openness";

export type BigFive = Record<BigFiveAxis, number>;

export const BIG_FIVE_LABEL: Record<BigFiveAxis, string> = {
  extraversion: "외향성",
  agreeableness: "친화성",
  conscientiousness: "성실성",
  emotionalStability: "정서 안정성",
  openness: "개방성",
};

export const PERSONALITY_CATEGORIES = ["사회성", "감정", "행동", "도덕성", "생활 태도", "관계 성향"] as const;
export type PersonalityCategory = (typeof PERSONALITY_CATEGORIES)[number];

export type PersonalityTag = {
  code: string;
  label: string;
  category: PersonalityCategory;
  weights: Partial<BigFive>;
};

export const PERSONALITY_TAGS: readonly PersonalityTag[] = [
  // 사회성
  { code: "sociable", label: "사교적", category: "사회성", weights: { extraversion: 20 } },
  { code: "reserved", label: "내성적", category: "사회성", weights: { extraversion: -20 } },
  { code: "talkative", label: "수다스러운", category: "사회성", weights: { extraversion: 15, conscientiousness: -5 } },
  { code: "leader", label: "리더형", category: "사회성", weights: { extraversion: 15, conscientiousness: 10 } },
  // 감정
  { code: "calm", label: "침착한", category: "감정", weights: { emotionalStability: 20 } },
  { code: "sensitive", label: "예민한", category: "감정", weights: { emotionalStability: -20 } },
  { code: "cheerful", label: "명랑한", category: "감정", weights: { extraversion: 10, emotionalStability: 10 } },
  { code: "hot_tempered", label: "다혈질", category: "감정", weights: { emotionalStability: -20, agreeableness: -10 } },
  // 행동
  { code: "diligent", label: "부지런한", category: "행동", weights: { conscientiousness: 20 } },
  { code: "impulsive", label: "충동적", category: "행동", weights: { conscientiousness: -20, emotionalStability: -5 } },
  { code: "cautious", label: "신중한", category: "행동", weights: { conscientiousness: 15, openness: -5 } },
  { code: "adventurous", label: "모험적", category: "행동", weights: { openness: 20, extraversion: 5 } },
  // 도덕성
  { code: "honest", label: "정직한", category: "도덕성", weights: { agreeableness: 10, conscientiousness: 10 } },
  { code: "cunning", label: "교활한", category: "도덕성", weights: { agreeableness: -20 } },
  { code: "just", label: "정의로운", category: "도덕성", weights: { conscientiousness: 10, agreeableness: 5 } },
  { code: "pragmatic", label: "실리적", category: "도덕성", weights: { openness: -10, conscientiousness: 5 } },
  // 생활 태도
  { code: "curious", label: "호기심 많은", category: "생활 태도", weights: { openness: 20 } },
  { code: "traditional", label: "보수적", category: "생활 태도", weights: { openness: -20 } },
  { code: "lazy", label: "게으른", category: "생활 태도", weights: { conscientiousness: -20 } },
  { code: "creative", label: "창의적", category: "생활 태도", weights: { openness: 15 } },
  // 관계 성향
  { code: "kind", label: "다정한", category: "관계 성향", weights: { agreeableness: 20 } },
  { code: "competitive", label: "경쟁적", category: "관계 성향", weights: { agreeableness: -15, extraversion: 5 } },
  { code: "loyal", label: "의리 있는", category: "관계 성향", weights: { agreeableness: 10, conscientiousness: 10 } },
  { code: "distrustful", label: "의심 많은", category: "관계 성향", weights: { agreeableness: -15, emotionalStability: -5 } },
];

export const PERSONALITY_TAG_CODES = PERSONALITY_TAGS.map((t) => t.code);

const BASE = 50;
const AXES: BigFiveAxis[] = ["extraversion", "agreeableness", "conscientiousness", "emotionalStability", "openness"];

/** 태그 코드 목록 → Big Five 수치 (기본 50 + 가중치 합, 0~100 clamp). 알 수 없는 코드는 무시한다 */
export function bigFiveFromTags(codes: readonly string[]): BigFive {
  const result = Object.fromEntries(AXES.map((a) => [a, BASE])) as BigFive;
  for (const code of codes) {
    const tag = PERSONALITY_TAGS.find((t) => t.code === code);
    if (!tag) continue;
    for (const axis of AXES) result[axis] += tag.weights[axis] ?? 0;
  }
  for (const axis of AXES) result[axis] = Math.min(100, Math.max(0, result[axis]));
  return result;
}
