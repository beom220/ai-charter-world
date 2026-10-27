// 정책 값은 이 파일에 모은다 (CLAUDE.md 코딩 규칙). 확정 수치는 docs/database.md §8.

/** 세계관당 활성 캐릭터(deletedAt IS NULL) 최대 수 */
export const MAX_ACTIVE_CHARACTERS_PER_WORLD = 6;

// ── Gemini 키 검증·모델 선택 (Phase 3-2). 운영 중 조정 가능한 초기값 ──

/** 연결 관리용 외부 호출(키 검증·모델 목록·모델 확인) 사용자당 허용 횟수 */
export const PROVIDER_CHECK_RATE_LIMIT = { maxCalls: 10, windowMs: 10 * 60 * 1000 } as const;

/** 키 검증·모델 조회 요청 타임아웃 */
export const GEMINI_METADATA_TIMEOUT_MS = 15_000;

/** 모델 사용 가능 확인(최소 생성 요청) 타임아웃과 출력 토큰 상한 */
export const GEMINI_PROBE_TIMEOUT_MS = 30_000;
export const GEMINI_PROBE_MAX_OUTPUT_TOKENS = 16;

/** 모델 목록 페이지 크기와 최대 페이지 수 (보통 1회 호출로 끝난다) */
export const GEMINI_MODEL_LIST_PAGE_SIZE = 1000;
export const GEMINI_MODEL_LIST_MAX_PAGES = 3;
