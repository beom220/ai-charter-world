import { AppError } from "@/server/domain/errors";

// 사용량 예약 단계의 거부 사유. 모두 Gemini로 요청을 보내기 전에 던진다 (외부 호출 없음).

/** 연결 관리용 호출(키 검증·모델 목록·모델 확인)의 사용자당 호출 한도 초과 (architecture.md §8.2) */
export class ProviderRateLimitError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, "RATE_LIMITED", `Gemini 확인 요청이 너무 많습니다. ${retryAfterSeconds}초 후 다시 시도하세요.`);
  }
}

export class ConnectionNotReadyError extends AppError {
  constructor(code: "GEMINI_NOT_CONNECTED" | "GEMINI_NOT_VERIFIED" | "GEMINI_MODEL_NOT_SELECTED") {
    const message = {
      GEMINI_NOT_CONNECTED: "Gemini API 키가 등록되어 있지 않습니다.",
      GEMINI_NOT_VERIFIED: "Gemini API 키를 먼저 검증하세요.",
      GEMINI_MODEL_NOT_SELECTED: "사용할 Gemini 모델을 먼저 선택하세요.",
    }[code];
    super(409, code, message);
  }
}

/**
 * 연결의 일일 요청·토큰 한도(KST 날짜) 도달 (architecture.md §8.3, PRD FR-07).
 * 시뮬레이션은 이 오류를 일반 장면 실패와 구분해 PAUSED(USAGE_LIMIT)로 전환한다. 자동으로 재개하지 않는다.
 */
export class UsageLimitError extends AppError {
  constructor(
    readonly limit: "REQUESTS" | "TOKENS",
    /** 다음 KST 자정 (UTC 시각) */
    readonly resetsAt: Date,
    readonly retryAfterSeconds: number,
  ) {
    super(
      429,
      "USAGE_LIMIT_REACHED",
      limit === "REQUESTS"
        ? "오늘(한국 시간 기준)의 Gemini 요청 한도에 도달했습니다. 한도를 올리거나 자정(KST) 이후에 다시 시도하세요."
        : "오늘(한국 시간 기준)의 Gemini 토큰 한도에 도달했습니다. 한도를 올리거나 자정(KST) 이후에 다시 시도하세요. 마지막 요청만큼 한도를 넘었을 수 있습니다.",
    );
  }
}

/** 서킷 브레이커가 열려 있음 (429·5xx·네트워크 연속 실패 후 백오프). 시뮬레이션은 RUNNING을 유지하고 until까지 기다린다 (A3). */
export class CircuitOpenError extends AppError {
  constructor(
    readonly until: Date,
    readonly reason: string,
    readonly retryAfterSeconds: number,
  ) {
    super(503, "GEMINI_BACKOFF", `Gemini API 오류가 이어져 잠시 요청을 멈췄습니다. ${retryAfterSeconds}초 후 다시 시도합니다.`);
  }
}

/** 예약 시점에 키가 바뀌어 있음 (호출 준비 중 교체). 이전 키로는 요청하지 않는다. */
export class KeyChangedError extends AppError {
  constructor() {
    super(409, "KEY_CHANGED", "API 키가 교체되었습니다. 새 키로 다시 검증하세요.");
  }
}
