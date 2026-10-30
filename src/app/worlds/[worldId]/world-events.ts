// 세계관 화면 안의 패널 간 알림 (Phase 6). SSE 연결은 대화 패널 하나만 열고, 다른 패널은 이 브라우저 이벤트로 받는다.
export const SAVES_EVENT = "world:saves-updated";
export const RUNTIME_EVENT = "world:runtime-status";
/** 캐릭터 현재 상태(감정 등)가 바뀌었을 수 있음 → 상단 고정 프로필이 다시 읽는다 (장면 커밋·불러오기·재동기화) */
export const CHARACTERS_EVENT = "world:characters-changed";
/** 캐릭터 상세가 다시 읽은 현재 감정 → 상세 상단 프로필 표정 (detail: { characterId, mood }) */
export const CHARACTER_MOOD_EVENT = "world:character-mood";

export function emitWorldEvent(type: typeof SAVES_EVENT | typeof RUNTIME_EVENT | typeof CHARACTERS_EVENT | typeof CHARACTER_MOOD_EVENT, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}
