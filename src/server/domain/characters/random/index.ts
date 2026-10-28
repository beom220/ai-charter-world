import { pickRandomBackground, requiresAdulthood } from "../../../../../config/character-backgrounds";
import { PERSONALITY_TAGS_MAX, PERSONALITY_TAGS_MIN, RANDOM_ADULT_AGE_RANGE } from "../../../../../config/limits";
import { PERSONALITY_CATEGORIES, PERSONALITY_TAGS } from "../../../../../config/personality-map";
import { GENDER_INPUTS, RANDOM_FIELDS, type CharacterDraft, type GenderInput, type RandomField } from "@/lib/schemas/character";
import { CONTEXT_TEMPLATES, GOAL_TEMPLATES, NAME_POOL } from "./data";

// 규칙 기반 캐릭터 랜덤 생성 (PRD FR-04, architecture.md §13). 런타임 독립 순수 함수.

export type Rng = () => number;

const pick = <T>(items: readonly T[], rng: Rng): T => items[Math.floor(rng() * items.length)]!;
const intBetween = (min: number, max: number, rng: Rng) => min + Math.floor(rng() * (max - min + 1));

/** 랜덤 성별은 남자·여자 중에서 고른다 (UI 선택지와 같다) */
export function randomGender(rng: Rng = Math.random): GenderInput {
  return pick(GENDER_INPUTS, rng);
}

export function randomAge(rng: Rng = Math.random): number {
  return intBetween(RANDOM_ADULT_AGE_RANGE.min, RANDOM_ADULT_AGE_RANGE.max, rng);
}

function randomName(gender: CharacterDraft["gender"], rng: Rng): string {
  const pool = gender === "MALE" ? NAME_POOL.MALE : gender === "FEMALE" ? NAME_POOL.FEMALE : [...NAME_POOL.MALE, ...NAME_POOL.FEMALE, ...NAME_POOL.NEUTRAL];
  return pick(pool, rng);
}

/** 서로 다른 분류에서 3~5개를 고른다 (상반된 태그가 함께 뽑히지 않게) */
function randomTags(rng: Rng): string[] {
  const count = intBetween(PERSONALITY_TAGS_MIN, PERSONALITY_TAGS_MAX, rng);
  const categories = [...PERSONALITY_CATEGORIES];
  const tags: string[] = [];
  while (tags.length < count && categories.length > 0) {
    const [category] = categories.splice(Math.floor(rng() * categories.length), 1);
    tags.push(pick(PERSONALITY_TAGS.filter((t) => t.category === category), rng).code);
  }
  return tags;
}

/**
 * 초안에 랜덤 값을 채운다. fields가 없으면 전체 랜덤, 있으면 그 필드만. 잠긴 필드는 언제나 유지한다.
 * 성별을 먼저 정해 이름 풀에 반영한다.
 * 배경(Phase 7-1): 프리셋에서만 고른다(등급 가중 추첨, 추가 LLM 호출 없음). 성년기는 나이를 정한 뒤 19세 이상일 때만 고른다.
 * 나이 규칙이 잠금보다 우선한다: 결과 나이가 18세 이하면 잠긴 성년기 배경도 비운다(화면이 안내한다). 나이를 비운 초안은 성인(자동)으로 본다.
 */
export function randomizeCharacter(
  draft: CharacterDraft,
  options: { lockedFields?: readonly RandomField[]; fields?: readonly RandomField[] } = {},
  rng: Rng = Math.random,
): CharacterDraft {
  const locked = new Set(options.lockedFields ?? []);
  const targets = new Set((options.fields ?? RANDOM_FIELDS).filter((f) => !locked.has(f)));
  const next: CharacterDraft = { ...draft };

  if (targets.has("gender")) next.gender = randomGender(rng);
  if (targets.has("name")) next.name = randomName(next.gender, rng);
  if (targets.has("age")) next.age = randomAge(rng);
  if (targets.has("personalityTags")) next.personalityTags = randomTags(rng);
  if (targets.has("goal")) next.goal = pick(GOAL_TEMPLATES, rng);
  if (targets.has("characterContext")) next.characterContext = pick(CONTEXT_TEMPLATES, rng);
  if (targets.has("childhoodBackgroundId")) next.childhoodBackgroundId = pickRandomBackground("CHILDHOOD", rng).id;
  const adult = next.age === null || requiresAdulthood(next.age);
  if (!adult) next.adulthoodBackgroundId = null;
  else if (targets.has("adulthoodBackgroundId")) next.adulthoodBackgroundId = pickRandomBackground("ADULTHOOD", rng).id;
  return next;
}
