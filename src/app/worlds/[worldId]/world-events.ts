// 세계관 화면 안의 패널 간 알림 (Phase 6). SSE 연결은 대화 패널 하나만 열고, 다른 패널은 이 브라우저 이벤트로 받는다.
export const SAVES_EVENT = "world:saves-updated";
export const RUNTIME_EVENT = "world:runtime-status";

export function emitWorldEvent(type: typeof SAVES_EVENT | typeof RUNTIME_EVENT, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}
