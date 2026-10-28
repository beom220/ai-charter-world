import { z } from "zod";
import {
  CHARACTER_AGE_MAX,
  CHARACTER_CONTEXT_MAX_LENGTH,
  CHARACTER_GENDER_CUSTOM_MAX_LENGTH,
  CHARACTER_NAME_MAX_LENGTH,
  PERSONALITY_TAGS_MAX,
  PERSONALITY_TAGS_MIN,
} from "../../../config/limits";
import { ADULTHOOD_BACKGROUND_IDS, ADULTHOOD_MIN_AGE, CHILDHOOD_BACKGROUND_IDS, requiresAdulthood } from "../../../config/character-backgrounds";
import { PERSONALITY_TAG_CODES } from "../../../config/personality-map";

// 캐릭터 생성·수정·랜덤 요청 스키마 (클라이언트·서버 공용, PRD FR-04, architecture.md §13).
// 글자 수는 코드 포인트(Array.from(s).length)로 센다. PostgreSQL VARCHAR와 같은 기준이다.

export const codePointLength = (s: string) => Array.from(s).length;

export const GENDERS = ["MALE", "FEMALE", "NONBINARY", "CUSTOM", "UNSPECIFIED"] as const;
export type GenderValue = (typeof GENDERS)[number];
/** AUTO는 입력 전용: 저장 시 서버가 성별을 정한다 */
export const GENDER_INPUTS = [...GENDERS, "AUTO"] as const;

export const GENDER_LABEL: Record<(typeof GENDER_INPUTS)[number], string> = {
  AUTO: "자동",
  MALE: "남성",
  FEMALE: "여성",
  NONBINARY: "논바이너리",
  CUSTOM: "직접 입력",
  UNSPECIFIED: "미지정",
};

export const CHARACTER_CONTEXT_MESSAGE = `캐릭터 컨텍스트는 최대 ${CHARACTER_CONTEXT_MAX_LENGTH}자입니다.`;
const NAME_MESSAGE = `이름은 1~${CHARACTER_NAME_MAX_LENGTH}자로 입력하세요.`;
const TAGS_MESSAGE = `성격 태그를 ${PERSONALITY_TAGS_MIN}~${PERSONALITY_TAGS_MAX}개 선택하세요.`;
const AGE_MESSAGE = `나이는 0~${CHARACTER_AGE_MAX} 사이 정수이거나 비워 두세요(자동).`;
const GENDER_CUSTOM_MESSAGE = `직접 입력 성별은 1~${CHARACTER_GENDER_CUSTOM_MAX_LENGTH}자로 입력하세요.`;

export const CHILDHOOD_REQUIRED_MESSAGE = "유년기 배경을 선택하세요.";
export const ADULTHOOD_REQUIRED_MESSAGE = `${ADULTHOOD_MIN_AGE}세 이상이면 성년기 배경을 선택해야 합니다.`;
export const ADULTHOOD_FORBIDDEN_MESSAGE = `${ADULTHOOD_MIN_AGE - 1}세 이하는 성년기 배경을 설정할 수 없습니다.`;

/**
 * 확정된 나이 기준 성년기 배경 규칙 (Phase 7-1). 19세 이상이면 필수, 18세 이하면 없어야 한다. 위반이면 안내 문구, 아니면 null.
 * 나이를 비워 둔 입력은 서버가 나이를 정한 뒤(생성: 성인 자동, 수정: 현재 나이 유지) 이 함수로 다시 검사한다.
 */
export function adulthoodBackgroundIssue(age: number, adulthoodBackgroundId: string | null | undefined): string | null {
  if (requiresAdulthood(age)) return adulthoodBackgroundId ? null : ADULTHOOD_REQUIRED_MESSAGE;
  return adulthoodBackgroundId ? ADULTHOOD_FORBIDDEN_MESSAGE : null;
}

const childhoodId = z.string({ error: CHILDHOOD_REQUIRED_MESSAGE }).refine((id) => CHILDHOOD_BACKGROUND_IDS.includes(id), { error: "알 수 없는 유년기 배경입니다." });
const adulthoodId = z.string().refine((id) => ADULTHOOD_BACKGROUND_IDS.includes(id), { error: "알 수 없는 성년기 배경입니다." });

const tagCode = z.string().refine((c) => PERSONALITY_TAG_CODES.includes(c), { error: "알 수 없는 성격 태그입니다." });

export const characterInputSchema = z
  .object({
    name: z
      .string({ error: NAME_MESSAGE })
      .trim()
      .refine((v) => v.length > 0 && codePointLength(v) <= CHARACTER_NAME_MAX_LENGTH, { error: NAME_MESSAGE }),
    gender: z.enum(GENDER_INPUTS, { error: "성별 값이 올바르지 않습니다." }),
    genderCustom: z.string().trim().nullish(),
    age: z.number({ error: AGE_MESSAGE }).int({ error: AGE_MESSAGE }).min(0, { error: AGE_MESSAGE }).max(CHARACTER_AGE_MAX, { error: AGE_MESSAGE }).nullable(),
    personalityTags: z
      .array(tagCode)
      .min(PERSONALITY_TAGS_MIN, { error: TAGS_MESSAGE })
      .max(PERSONALITY_TAGS_MAX, { error: TAGS_MESSAGE })
      .refine((tags) => new Set(tags).size === tags.length, { error: "같은 성격 태그를 두 번 선택할 수 없습니다." }),
    goal: z.string().trim().default(""),
    characterContext: z
      .string({ error: CHARACTER_CONTEXT_MESSAGE })
      .refine((v) => codePointLength(v) <= CHARACTER_CONTEXT_MAX_LENGTH, { error: CHARACTER_CONTEXT_MESSAGE }),
    // 고정 프리셋 ID만 받는다(직접 입력 없음). 유년기는 항상 필수, 성년기는 나이 규칙을 따른다
    childhoodBackgroundId: childhoodId,
    adulthoodBackgroundId: adulthoodId.nullable().default(null),
  })
  .strip() // worldId·deletedAt·Big Five 수치 등은 받지 않는다 (수치는 태그에서 계산)
  .superRefine((v, ctx) => {
    if (v.age !== null) {
      const issue = adulthoodBackgroundIssue(v.age, v.adulthoodBackgroundId);
      if (issue) ctx.addIssue({ code: "custom", path: ["adulthoodBackgroundId"], message: issue });
    }
    if (v.gender !== "CUSTOM") return;
    const len = codePointLength(v.genderCustom ?? "");
    if (len === 0 || len > CHARACTER_GENDER_CUSTOM_MAX_LENGTH) ctx.addIssue({ code: "custom", path: ["genderCustom"], message: GENDER_CUSTOM_MESSAGE });
  });

export type CharacterInput = z.infer<typeof characterInputSchema>;

/** 랜덤 생성 대상 필드 */
export const RANDOM_FIELDS = ["name", "gender", "age", "personalityTags", "goal", "characterContext", "childhoodBackgroundId", "adulthoodBackgroundId"] as const;
export type RandomField = (typeof RANDOM_FIELDS)[number];

/** 랜덤 초안. 아직 검증 전인 편집 중 값이므로 느슨하게 받는다 */
export const characterDraftSchema = z.object({
  name: z.string().max(CHARACTER_NAME_MAX_LENGTH * 4).default(""),
  gender: z.enum(GENDER_INPUTS).default("AUTO"),
  genderCustom: z.string().max(CHARACTER_GENDER_CUSTOM_MAX_LENGTH * 4).nullish(),
  age: z.number().int().min(0).max(CHARACTER_AGE_MAX).nullable().default(null),
  personalityTags: z.array(z.string().max(64)).max(PERSONALITY_TAG_CODES.length).default([]),
  goal: z.string().max(10_000).default(""),
  characterContext: z.string().max(CHARACTER_CONTEXT_MAX_LENGTH * 4).default(""),
  childhoodBackgroundId: z.string().max(64).nullable().default(null),
  adulthoodBackgroundId: z.string().max(64).nullable().default(null),
});

export type CharacterDraft = z.infer<typeof characterDraftSchema>;

/**
 * 랜덤 요청 (architecture.md §13). fields가 없으면 전체 랜덤, 있으면 항목별 랜덤.
 * 잠금은 클라이언트 상태이며 lockedFields로 전달한다. 잠긴 필드는 전체·항목별 랜덤 모두에서 유지한다.
 */
export const characterRandomRequestSchema = z
  .object({
    draft: characterDraftSchema.default(characterDraftSchema.parse({})),
    lockedFields: z.array(z.enum(RANDOM_FIELDS)).default([]),
    fields: z.array(z.enum(RANDOM_FIELDS)).optional(),
  })
  .strip();
