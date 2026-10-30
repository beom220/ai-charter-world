import { PERSONALITY_TAGS_MAX } from "../../config/limits";
import type { CharacterDraft } from "@/lib/schemas/character";

// 캐릭터 화면 순수 로직 (UI 개선). DOM·React에 의존하지 않아 단위 테스트한다.

/** 새 캐릭터 폼의 빈 상태. 생성 화면에 들어올 때마다 이 값으로 시작한다 */
export const EMPTY_CHARACTER_DRAFT: CharacterDraft = {
  name: "",
  gender: null,
  age: null,
  personalityTags: [],
  characterContext: "",
  childhoodBackgroundId: null,
  adulthoodBackgroundId: null,
  avatarId: null,
};

/** 성격 태그 선택 토글: 이미 있으면 빼고, 없으면 최대 개수 안에서만 더한다 */
export function togglePersonalityTag(selected: readonly string[], code: string): string[] {
  if (selected.includes(code)) return selected.filter((c) => c !== code);
  return selected.length >= PERSONALITY_TAGS_MAX ? [...selected] : [...selected, code];
}

/**
 * 대화 속 발화자 이름의 링크. 이 세계관의 활성 캐릭터 ID일 때만 상세로 연결한다(이름이 같아도 ID로 구분).
 * 삭제되었거나(활성 목록에 없음) 행이 사라진 발화자는 null → 링크 없이 '삭제된 캐릭터'로 표시한다
 */
export function speakerHref(worldId: string, speakerCharacterId: string | null, activeIds: ReadonlySet<string>): string | null {
  return speakerCharacterId && activeIds.has(speakerCharacterId) ? `/worlds/${worldId}/characters/${speakerCharacterId}` : null;
}
