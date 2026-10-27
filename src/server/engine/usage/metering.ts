import type { GeminiCallRecord, GeminiErrorKind, GeminiOperation } from "@/server/llm/gemini/client";

// 호출 결과 분류 (architecture.md §8.3, §12). DB에 의존하지 않는 순수 함수.

export type ApiOutcomeValue = "SUCCESS" | "HTTP_ERROR" | "NETWORK_ERROR" | "VALIDATION_ERROR";
export type UsageStatusValue = "REPORTED" | "MISSING" | "UNKNOWN" | "NOT_APPLICABLE";

/**
 * 서킷 브레이커 관점의 실패 종류
 * - NONE: 정상 응답
 * - RATE_LIMIT: 429 (할당량·속도 제한) → 즉시 지수 백오프
 * - TRANSIENT: 5xx·네트워크·시간 초과 → 연속 3회부터 지수 백오프
 * - KEY: 키 무효 (영구) → 연결 INVALID, 키를 교체할 때까지 차단
 * - REQUEST: 권한·모델·요청 형식·미완료 응답 (요청 단위, 일시 장애 아님) → 브레이커에 반영하지 않음
 */
export type FailureClass = "NONE" | "RATE_LIMIT" | "TRANSIENT" | "KEY" | "REQUEST";

const FAILURE_CLASS: Record<GeminiErrorKind, FailureClass> = {
  QUOTA_EXCEEDED: "RATE_LIMIT",
  UPSTREAM_ERROR: "TRANSIENT",
  TIMEOUT: "TRANSIENT",
  NETWORK_ERROR: "TRANSIENT",
  KEY_INVALID: "KEY",
  PERMISSION_DENIED: "REQUEST",
  MODEL_NOT_FOUND: "REQUEST",
  BAD_REQUEST: "REQUEST",
  INCOMPLETE_RESPONSE: "REQUEST",
};

export function failureClassOf(kind: GeminiErrorKind | null): FailureClass {
  return kind === null ? "NONE" : FAILURE_CLASS[kind];
}

/** ApiRequestLog.outcome. HTTP 200이지만 완료되지 않은 생성은 VALIDATION_ERROR (§12) */
export function outcomeOf(record: Pick<GeminiCallRecord, "errorKind" | "httpStatus">): ApiOutcomeValue {
  const { errorKind, httpStatus } = record;
  if (errorKind === null) return "SUCCESS";
  if (errorKind === "INCOMPLETE_RESPONSE") return "VALIDATION_ERROR";
  if (errorKind === "NETWORK_ERROR" || (errorKind === "TIMEOUT" && httpStatus === null)) return "NETWORK_ERROR";
  return "HTTP_ERROR";
}

/** 토큰을 쓰는 요청인가 (모델 목록·조회는 토큰을 쓰지 않는다) */
export const consumesTokens = (operation: GeminiOperation) => operation === "models.generateContent";

/**
 * 토큰 사용량 상태. 사용량이 없을 때 0으로 단정하지 않는다.
 * - 생성 요청이 응답(200)을 받았는데 usageMetadata가 없음 → MISSING
 * - 생성 요청이 5xx·시간 초과·네트워크로 끝남 → UNKNOWN (생성·과금 여부를 알 수 없음)
 * - 생성 요청이 4xx로 거부됨(키·권한·모델·할당량·형식) → NOT_APPLICABLE (생성 전 거부)
 */
export function usageStatusOf(record: Pick<GeminiCallRecord, "operation" | "httpStatus" | "errorKind" | "usage">): UsageStatusValue {
  if (!consumesTokens(record.operation)) return "NOT_APPLICABLE";
  if (record.usage) return "REPORTED";
  if (record.httpStatus === 200) return "MISSING";
  if (record.errorKind !== null && FAILURE_CLASS[record.errorKind] === "TRANSIENT") return "UNKNOWN";
  return "NOT_APPLICABLE";
}

/** 일일 토큰 집계에 더할 값 (보고되지 않은 항목은 더하지 않는다) */
export function tokenTotals(record: Pick<GeminiCallRecord, "usage">) {
  return {
    inputTokens: record.usage?.inputTokens ?? 0,
    outputTokens: record.usage?.outputTokens ?? 0,
    thoughtTokens: record.usage?.thoughtTokens ?? 0,
  };
}
