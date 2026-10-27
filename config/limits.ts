// 정책 값은 이 파일에 모은다 (CLAUDE.md 코딩 규칙). 확정 수치는 docs/database.md §8.

/** 세계관당 활성 캐릭터(deletedAt IS NULL) 최대 수 */
export const MAX_ACTIVE_CHARACTERS_PER_WORLD = 6;

// ── Gemini 키 검증·모델 선택 (Phase 3-2). 운영 중 조정 가능한 초기값 ──

/** 연결 관리용 외부 호출(키 검증·모델 목록·모델 확인) 사용자당 허용 횟수 */
export const PROVIDER_CHECK_RATE_LIMIT = { maxCalls: 10, windowMs: 10 * 60 * 1000 } as const;

/** 키 검증·모델 조회 요청 타임아웃 */
export const GEMINI_METADATA_TIMEOUT_MS = 15_000;

/**
 * 모델 사용 가능 확인(최소 생성 요청) 타임아웃과 출력 토큰 상한.
 * 타임아웃은 architecture.md §6.5 설계값(60초). SDK가 X-Server-Timeout 헤더로 Google에 전달한다.
 * 출력 상한은 사고 토큰을 포함하므로(공식 thinking 문서) 응답이 완료될 수 있게 128로 둔다.
 */
export const GEMINI_PROBE_TIMEOUT_MS = 60_000;
export const GEMINI_PROBE_MAX_OUTPUT_TOKENS = 128;

/** 모델 목록 페이지 크기와 최대 페이지 수 (보통 1회 호출로 끝난다) */
export const GEMINI_MODEL_LIST_PAGE_SIZE = 1000;
export const GEMINI_MODEL_LIST_MAX_PAGES = 3;

// ── 연결 단위 백오프·서킷 브레이커 (Phase 3-3, architecture.md §8.3) ──

/** 지수 백오프: 기본 5초에서 두 배씩, 최대 5분 */
export const BREAKER_BACKOFF_BASE_MS = 5_000;
export const BREAKER_BACKOFF_MAX_MS = 5 * 60 * 1000;

/** 5xx·네트워크·시간 초과는 연속 3회 실패부터 백오프한다 */
export const BREAKER_TRANSIENT_FAILURE_THRESHOLD = 3;

/** 429 응답의 RetryInfo(retryDelay)를 우선하되, 비정상적으로 긴 값은 이 값으로 자른다 */
export const BREAKER_RETRY_AFTER_MAX_MS = 60 * 60 * 1000;

/**
 * 백오프가 끝난 뒤 첫 요청 1건만 시험 삼아 보낸다(half-open). 그 요청이 끝날 때까지 다른 요청은 기다린다.
 * 정산되지 않으면(프로세스 종료 등) 이 시간이 지나 자동으로 풀린다. 생성 요청 타임아웃(60초)과 같게 둔다.
 */
export const BREAKER_HALF_OPEN_HOLD_MS = 60_000;

// ── 사용량 예약 (Phase 3-3, architecture.md §8.3) ──

/**
 * 예약(PENDING) 후 이 시간이 지나도 정산되지 않은 호출은 결과를 잃은 것으로 본다(프로세스 종료 등).
 * 요청 타임아웃(최대 60초)보다 충분히 길게 둔다. 같은 연결의 다음 예약 때 정리한다.
 */
export const USAGE_PENDING_STALE_MS = 5 * 60 * 1000;

// ── 세계관 (Phase 4-1, PRD FR-03) ──

/** HTTP 요청 본문 최대 크기 (확정, A8). worldContext는 글자 수 제한 없이 이 한도 안에서 저장한다 */
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

/** 세계관 이름 최대 길이(코드 포인트). World.name VarChar(100)과 같다 */
export const WORLD_NAME_MAX_LENGTH = 100;

// ── 캐릭터 (Phase 4-2, PRD FR-04, architecture.md §13) ──

/** 캐릭터 컨텍스트 최대 길이(코드 포인트, Array.from(s).length). Character.characterContext VarChar(300)과 같다 */
export const CHARACTER_CONTEXT_MAX_LENGTH = 300;

/** 캐릭터 이름 최대 길이(코드 포인트). Character.name VarChar(50) */
export const CHARACTER_NAME_MAX_LENGTH = 50;

/** 성별 직접 입력 최대 길이. Character.genderCustom VarChar(30) */
export const CHARACTER_GENDER_CUSTOM_MAX_LENGTH = 30;

/** 성격 태그 선택 개수 (PRD 권장 3~5개) */
export const PERSONALITY_TAGS_MIN = 3;
export const PERSONALITY_TAGS_MAX = 5;

/** 나이 입력 범위 (DB CHECK 0~1000, 판타지 종족 고려) */
export const CHARACTER_AGE_MAX = 1000;

/** 랜덤·자동 나이 범위 (성인 기본, 세계관 템플릿 도입 전 공통값) */
export const RANDOM_ADULT_AGE_RANGE = { min: 20, max: 59 } as const;

// ── 대화 장면 생성 (Phase 5-1, architecture.md §6.4·§6.5 StoryMode) ──

/** 장면 참가자 수 (StoryMode 기본 2~3명) */
export const SCENE_PARTICIPANTS_MIN = 2;
export const SCENE_PARTICIPANTS_MAX = 3;

/** 장면 최소 턴 수. 최대는 GameState.maxTurnsPerScene(기본 6) */
export const SCENE_TURNS_MIN = 3;

/** 장면 생성 요청 타임아웃 (architecture.md §6.5 기본 60초) */
export const SCENE_GENERATION_TIMEOUT_MS = 60_000;

/** 장면 생성 출력 토큰 상한 (사고 토큰 포함). 6턴×400자 JSON이 잘리지 않을 만큼 */
export const SCENE_MAX_OUTPUT_TOKENS = 8192;

export const SCENE_TEMPERATURE = 0.9;

/**
 * 프롬프트에 넣는 세계관 컨텍스트 예산(문자 수, MVP 보수적 추정). 넘으면 문단 단위로 앞에서부터 넣고 나머지는 미반영(D6).
 * 원본은 그대로 저장한다. 토큰 기반 예산은 엔진 단계에서 조정한다(A17).
 */
export const SCENE_WORLD_CONTEXT_BUDGET_CHARS = 30_000;

/** 세계 규칙·현재 상황 각각의 프롬프트 상한(문자 수). 넘으면 뒷부분 절단 */
export const SCENE_WORLD_FIELD_BUDGET_CHARS = 4_000;

/** 수동 장면 생성 진행 표시(inFlightAttemptId)가 이 시간보다 오래되면 끝난 것으로 본다 (프로세스 종료 대비) */
export const SCENE_IN_FLIGHT_STALE_MS = 5 * 60 * 1000;
