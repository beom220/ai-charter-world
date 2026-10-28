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
export const RANDOM_ADULT_AGE_RANGE = { min: 20, max: CHARACTER_AGE_MAX } as const;

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

/** 다음 장면 프롬프트에 넣는 최근 완료 장면 수 (Phase 5-2, MVP 초기값) */
export const SCENE_RECENT_HISTORY_SCENES = 5;

/** 최근 장면 기록의 프롬프트 상한(문자 수). 넘으면 오래된 턴부터 제외한다(architecture.md §6.4) */
export const SCENE_RECENT_HISTORY_BUDGET_CHARS = 8_000;

/** 세계관 상세의 대화 기록 한 페이지 장면 수 ('이전 기록 보기' 단위) */
export const SCENE_HISTORY_PAGE_SIZE = 10;

/** SSE 연결 유지 주석(`: ping`) 간격 (architecture.md §10.1). 이때 outbox도 한 번 따라잡는다 */
export const SSE_PING_INTERVAL_MS = 15_000;

/** SseConnection.lastSeenAt 갱신 간격 (§7.5) */
export const SSE_HEARTBEAT_INTERVAL_MS = 10_000;

/** 재연결 시 한 번에 재전송하는 outbox 이벤트 상한. 넘으면 sync.required */
export const SSE_REPLAY_MAX_EVENTS = 100;

/**
 * 새 장면 발언의 브라우저 재생 템포(UI 연출 전용, ms 범위 [최소, 최대]에서 무작위).
 * 이전 발언 뒤 잠깐 쉬고(gap) → 다음 발언자 "입력 중…"(typing) → 대사 공개를 반복한다.
 * 장면 사이 간격(SLOW 15s / NORMAL 5s / FAST 1s, Runner)과는 별개이며, 이후 속도 옵션에 맞춰 이 값을 바꿔 넘긴다.
 */
export const SCENE_PLAYBACK_TIMING = {
  gapMs: [500, 900],
  typingMs: [1_500, 3_000],
} as const satisfies { gapMs: readonly [number, number]; typingMs: readonly [number, number] };

/** 수동 장면 생성 진행 표시(inFlightAttemptId)가 이 시간보다 오래되면 끝난 것으로 본다 (프로세스 종료 대비) */
export const SCENE_IN_FLIGHT_STALE_MS = 5 * 60 * 1000;

// ── 자동 실행 Runner (Phase 5-4-2, architecture.md §6.3·§7.4) ──

/** 장면 사이 최소 간격(이전 장면 완료 시점부터). GameState.intervalPreset (확정: 15/5/1초) */
export const SCENE_INTERVAL_MS = { SLOW: 15_000, NORMAL: 5_000, FAST: 1_000 } as const satisfies Record<"SLOW" | "NORMAL" | "FAST", number>;

/** 실행 lease 유효 시간과 갱신(heartbeat) 간격 (§7.4) */
export const RUNNER_LEASE_TTL_MS = 30_000;
export const RUNNER_LEASE_RENEW_MS = 10_000;

/** Runner가 대기 중에도 DB 상태를 다시 읽는 최대 간격 (신호 유실 대비, §7.3) */
export const RUNNER_POLL_INTERVAL_MS = 2_000;
/** 설정 화면: 실행 중·진행 중 장면 때문에 수정이 막혀 있는 동안 실행 상태를 다시 확인하는 간격 (Phase 7-2) */
export const SETTINGS_LOCK_POLL_MS = 3_000;

/** 복구 스위퍼 주기: lease가 비었거나 만료된 RUNNING·PAUSING 세계관을 찾아 Runner를 붙인다 (§7.4) */
export const RUNNER_SWEEP_INTERVAL_MS = 15_000;

/**
 * 장면 실패(검증 실패·요청 오류 등)가 이어질 때 다음 시도까지의 간격 상한.
 * 실패마다 간격(최소 5초)을 두 배로 늘린다. 서킷 브레이커가 다루지 않는 요청 단위 오류의 반복 과금을 줄인다.
 */
export const RUNNER_FAILURE_BACKOFF_MIN_MS = 5_000;
export const RUNNER_FAILURE_BACKOFF_MAX_MS = 5 * 60 * 1000;

// ── SSE 연결 보류·outbox 정리 (Phase 5-4-3, architecture.md §7.5·§10.3) ──

/** 활성 SSE 연결 = lastSeenAt이 이 시간 이내인 SseConnection 행 (heartbeat 10초 × 3) */
export const SSE_CONNECTION_ACTIVE_MS = 30_000;

/** 활성 연결이 0이 된 뒤 이 시간 안에 재연결이 없으면 PAUSED(CLIENT_DISCONNECTED) (확정, D4) */
export const CLIENT_HOLD_TIMEOUT_MS = 60_000;

/** outbox(SimulationEvent) 보관 기간 (확정, A16) */
export const OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000;

/** 비정상 종료로 남은 SseConnection 행 삭제 기준 (활성 판정과 무관한 청소용) */
export const SSE_CONNECTION_PURGE_MS = 10 * 60 * 1000;

/** outbox·연결 등록부 정리 주기 (RunnerHost 스위퍼에서 실행) */
export const OUTBOX_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// ── 감정·관계·기억 반영 (Phase 5-5, architecture.md §6.5~§6.7, A15) ──

/** 장면당 변화량 상한 (확정, A15). 초과 제안은 clamp */
export const EMOTION_INTENSITY_DELTA_MAX = 20;
export const RELATIONSHIP_AXIS_DELTA_MAX = 5;

/** 값 범위 (DB CHECK와 같음) */
export const EMOTION_INTENSITY_RANGE = { min: 0, max: 100 } as const;
export const RELATIONSHIP_AXIS_RANGE = { min: -100, max: 100 } as const;
export const RELATIONSHIP_FAMILIARITY_RANGE = { min: 0, max: 100 } as const;

/** 감정 행이 없을 때의 시작값 */
export const EMOTION_DEFAULT = { mood: "NEUTRAL", intensity: 50 } as const;

/** 장면당 저장하는 기억 수 상한: 캐릭터당 2개, 장면 전체 6개 (중요도 높은 것부터). 기억 내용 최대 300자 */
export const MEMORY_PER_OWNER_PER_SCENE = 2;
export const MEMORY_PER_SCENE_MAX = 6;
export const MEMORY_CONTENT_MAX_LENGTH = 300;

/** 다음 장면 프롬프트에 넣는 캐릭터별 기억: 중요도·최신순 최대 8개, 캐릭터당 1,500자 (§6.4 "중요도 낮은 것부터 제외") */
export const SCENE_MEMORY_PER_CHARACTER = 8;
export const SCENE_MEMORY_BUDGET_CHARS_PER_CHARACTER = 1_500;

// ── 세이브 (Phase 6, architecture.md §9) ──

/** 세계관당 사용자 표시 슬롯 = 수동 5 + 자동 5 (확정, 2026-10-28). 복구 지점(RECOVERY)은 별도 1개 */
export const MANUAL_SAVE_SLOTS = 5;
export const AUTO_SAVE_SLOTS = 5;

/** 자동 저장 간격(마지막 성공 기준)과 실패 후 재시도 간격 */
export const AUTO_SAVE_INTERVAL_MS = 60 * 60 * 1000;
export const AUTO_SAVE_RETRY_MS = 10 * 60 * 1000;

/** 저장 이름 최대 길이(코드 포인트). SaveGame.name VarChar(60) */
export const SAVE_NAME_MAX_LENGTH = 60;

/** 현재 스냅샷 payload 버전 (lib/snapshot). v2 = 캐릭터 배경 추가 (Phase 7-1) */
export const SNAPSHOT_SCHEMA_VERSION = 2;

/** 저장·불러오기 트랜잭션 제한 시간 (대화 기록 전체를 캡처·복원하므로 기본 5초보다 길게) */
export const SAVE_TRANSACTION_TIMEOUT_MS = 30_000;
