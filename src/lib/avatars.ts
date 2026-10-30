import { AVATAR_IDS, FEMALE_AVATAR_IDS, MALE_AVATAR_IDS, type AvatarExpression } from "../../config/avatars";

// 캐릭터 프로필 일러스트 표시·선택 규칙 (클라이언트·서버 공용 순수 함수).
// - 생성·편집 화면과 대화창은 항상 neutral, 상단 고정 프로필과 캐릭터 상세는 현재 감정 표정(moodExpression).
// - 감정 계산·프롬프트와 무관하다. 표시만 바꾼다.

/** 감정 12종 → 표정 8종. 감정이 없거나 모르는 값이면 neutral */
const MOOD_EXPRESSION: Record<string, AvatarExpression> = {
  NEUTRAL: "neutral",
  CALM: "neutral",
  HAPPY: "happy",
  EXCITED: "happy",
  HOPEFUL: "hopeful",
  SAD: "sad",
  LONELY: "sad",
  ANXIOUS: "anxious",
  FEARFUL: "anxious",
  ANGRY: "angry",
  EMBARRASSED: "embarrassed",
  TIRED: "tired",
};

export function moodExpression(mood: string | null | undefined): AvatarExpression {
  return (mood && MOOD_EXPRESSION[mood]) || "neutral";
}

export const isAvatarId = (id: string | null | undefined): id is string => typeof id === "string" && AVATAR_IDS.includes(id);

/** 성별에 맞는 일러스트 목록. 남자·여자 외의 값(기존 데이터)은 빈 목록 */
export function avatarIdsFor(gender: string | null | undefined): readonly string[] {
  return gender === "FEMALE" ? FEMALE_AVATAR_IDS : gender === "MALE" ? MALE_AVATAR_IDS : [];
}

export const isAvatarForGender = (id: string | null | undefined, gender: string | null | undefined) => !!id && avatarIdsFor(gender).includes(id);

/** 정적 파일 경로. 알 수 없는 ID면 null (화면은 대체 표시) */
export function avatarSrc(id: string | null | undefined, expression: AvatarExpression = "neutral"): string | null {
  return isAvatarId(id) ? `/characters/${id}/${expression}.webp` : null;
}

/** 같은 세계관에서 쓰이지 않은, 성별에 맞는 일러스트 하나를 고른다. 남은 것이 없으면 null (중복을 허용하지 않는다) */
export function pickAvailableAvatar(gender: string | null | undefined, used: Iterable<string>, rng: () => number = Math.random): string | null {
  const taken = new Set(used);
  const free = avatarIdsFor(gender).filter((id) => !taken.has(id));
  return free.length ? free[Math.floor(rng() * free.length)]! : null;
}

export const AVATAR_IN_USE_MESSAGE = "이 세계관의 다른 캐릭터가 이미 사용 중인 일러스트입니다. 다른 일러스트를 선택하세요.";
export const AVATAR_EXHAUSTED_MESSAGE = "이 성별로 고를 수 있는 일러스트가 모두 사용 중입니다. 다른 캐릭터의 일러스트를 바꾸거나 캐릭터를 정리한 뒤 다시 시도하세요.";
export const AVATAR_REQUIRED_MESSAGE = "프로필 일러스트를 선택하세요.";
