// 캐릭터 프로필 일러스트 고정 목록 (public/characters/{avatarId}/{expression}.webp). 클라이언트·서버 공용 단일 소스.
// - DB·세이브에는 avatarId만 저장한다. 이미지를 임의로 바꾸거나 더하지 않는다(에셋 검증: tests/unit/avatar-assets.test.ts).
// - 여성 캐릭터는 여성 17종, 남성 캐릭터는 남성 6종에서만 고른다. 같은 세계관의 활성 캐릭터끼리는 같은 avatarId를 쓸 수 없다.

const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(2, "0")}`);

export const FEMALE_AVATAR_IDS: readonly string[] = ids("female", 17);
export const MALE_AVATAR_IDS: readonly string[] = ids("male", 6);
export const AVATAR_IDS: readonly string[] = [...FEMALE_AVATAR_IDS, ...MALE_AVATAR_IDS];

/** 일러스트마다 있는 표정 8종 (파일 이름) */
export const AVATAR_EXPRESSIONS = ["neutral", "happy", "hopeful", "sad", "anxious", "angry", "embarrassed", "tired"] as const;
export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];

/** avatarId 저장 길이 (Character.avatarId VARCHAR) */
export const AVATAR_ID_MAX_LENGTH = 32;
