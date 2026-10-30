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

/** 랜덤 나이 범위 (PRD v2.6). 저장 시 빈 나이 자동 설정은 성년기 배경과 맞도록 성인(ADULTHOOD_MIN_AGE)부터 상한까지 */
export const RANDOM_AGE_RANGE = { min: 1, max: 80 } as const;

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

/** 완료 알림 토스트(캐릭터 저장 등)가 보였다 사라지기까지의 시간. 닫기 버튼으로 더 빨리 닫을 수 있다 */
export const TOAST_DURATION_MS = 2_000;

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

/** 현재 스냅샷 payload 버전 (lib/snapshot). v2 = 캐릭터 배경 추가 (Phase 7-1), v3 = 사건·자동 사건 구간·캐릭터 신체 상태 (Phase 7-2),
 *  v4 = 월드 시간·온도 불편(원인·단계)·고통 분리 (Phase 7-2-2), v5 = 캐릭터 프로필 일러스트 avatarId, v6 = 캐릭터 목표(goal) 제거 */
export const SNAPSHOT_SCHEMA_VERSION = 6;

/** 저장·불러오기 트랜잭션 제한 시간 (대화 기록 전체를 캡처·복원하므로 기본 5초보다 길게) */
export const SAVE_TRANSACTION_TIMEOUT_MS = 30_000;

// ── 사건 시스템·캐릭터 신체 상태 (Phase 7-2 확정 정책)

/** 자동 사건: 장면 #3부터 20장면 구간(#3~#22, #23~#42 …)마다 한 번만 40%로 추첨하고, 당첨되면 구간 안 장면 하나에 예약한다 */
export const AUTO_EVENT_FIRST_SCENE_SEQ = 3;
export const AUTO_EVENT_PERIOD_SCENES = 20;
export const AUTO_EVENT_CHANCE = 0.4;
/** 자동 사건 프리셋 후보에서 뺄 최근 프리셋 수 (직전 범주도 뺀다. 후보가 없으면 단계적으로 완화) */
export const AUTO_EVENT_RECENT_PRESET_EXCLUDE = 8;

/** 사용자 지정 사건: 내용 최대 200자(코드 포인트), 세계관별 대기 최대 3건, 제출 간격 30초, KST 하루 30건 */
export const USER_EVENT_TEXT_MAX_LENGTH = 200;
export const USER_EVENT_PENDING_MAX = 3;
export const USER_EVENT_MIN_INTERVAL_MS = 30_000;
export const USER_EVENTS_PER_DAY = 30;

// ── 신체 상태 규칙 (Phase 7-2-2, 월드 시간 기준). MVP용 보수적 초깃값이며 실제 의학적 기준이 아니다.
//    자연 회복·고통 완화·극심 지속·사망 위험은 모두 월드 시간으로 판정하고, 장면 커밋은 결과를 확정하는 시점만 담당한다.

const WORLD_HOUR = 60 * 60;

/** 부상 자연 회복: 마지막 부상 변화 뒤 이 월드 시간이 지나면 한 단계 낮아진다. null = 치료 없이는 나아지지 않음(위독) */
export const INJURY_NATURAL_RECOVERY_WORLD_SECONDS = { NONE: null, MILD: 24 * WORLD_HOUR, MODERATE: 72 * WORLD_HOUR, SEVERE: 168 * WORLD_HOUR, CRITICAL: null } as const satisfies Record<
  "NONE" | "MILD" | "MODERATE" | "SEVERE" | "CRITICAL",
  number | null
>;
/** 고통 자연 완화: 마지막 고통 변화 뒤 12 월드 시간마다 한 단계 (부상이 남기는 최소 고통 아래로는 내려가지 않음) */
export const PAIN_NATURAL_EASE_WORLD_SECONDS = 12 * WORLD_HOUR;
/** 극심(온도 불편 극심·고통 극심·위독 부상)이 이 시간 이상 이어지면 생명 위험: 장면이 제안한 사망을 받아들일 수 있다 */
export const EXTREME_LIFE_RISK_WORLD_SECONDS = 12 * WORLD_HOUR;
/** 극심이 이 시간 이상 끊김 없이 이어지면 다음 장면 커밋에서 서버가 사망을 확정한다 (월드 48시간 = 실제 80분 진행) */
export const EXTREME_LETHAL_WORLD_SECONDS = 48 * WORLD_HOUR;
/** 한 장면에서 허용하는 악화 단계 (재난·고강도 사건이 진행 중이면 +1 예외) */
export const CONDITION_MAX_WORSEN_STEPS_PER_SCENE = 1;

// ── 월드 시간 (Phase 7-2-2)

/** 실제 1시간 = 월드 36시간(1.5일). 실제 1초 = 월드 36초, 월드 1일 = 실제 40분. 장면 간격(실행 속도)과 별개이며 곱하지 않는다 */
export const WORLD_TIME_SCALE = 36;
export const WORLD_DAY_SECONDS = 24 * 60 * 60;
/**
 * 서버가 실행 중임을 마지막으로 확인한 뒤 이 시간이 지나도록 확인이 없으면(크래시·장시간 정지) 그 구간은 세지 않는다.
 * Runner는 대기 중 2초, Gemini 호출 중 10초마다 확인을 남기므로 lease TTL과 같은 30초로 둔다.
 */
export const WORLD_CLOCK_MAX_GAP_MS = 30_000;
