import {
  BREAKER_BACKOFF_BASE_MS,
  BREAKER_BACKOFF_MAX_MS,
  BREAKER_HALF_OPEN_HOLD_MS,
  BREAKER_RETRY_AFTER_MAX_MS,
  BREAKER_TRANSIENT_FAILURE_THRESHOLD,
} from "../../../../config/limits";
import type { FailureClass } from "./metering";

// 연결 단위 서킷 브레이커 (architecture.md §8.3, D8). DB에 의존하지 않는 순수 상태 전이.
// - 닫힘: blockedUntil 없음, backoffLevel 0 → 요청 허용
// - 열림: blockedUntil > now → 요청을 보내지 않고 거부
// - 반열림(half-open): 백오프가 끝났지만 backoffLevel > 0 → 1건만 시험 요청을 허용하고, 끝날 때까지 다른 요청은 기다린다
// - 자동 재시도는 하지 않는다. 브레이커는 다음 "새" 요청을 언제 보낼 수 있는지만 정한다.

export type BreakerState = {
  consecutiveFailures: number;
  backoffLevel: number;
  blockedUntil: Date | null;
  blockReason: string | null;
};

export const BLOCK_REASON = {
  RATE_LIMITED: "RATE_LIMITED", // 429
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE", // 5xx·네트워크·시간 초과 연속 실패
  HALF_OPEN: "HALF_OPEN", // 시험 요청 진행 중
} as const;

export const CLOSED: BreakerState = { consecutiveFailures: 0, backoffLevel: 0, blockedUntil: null, blockReason: null };

export type GateDecision =
  | { allowed: true; trial: false }
  /** 반열림 시험 요청. next를 저장해 다른 요청을 막는다 */
  | { allowed: true; trial: true; next: BreakerState }
  | { allowed: false; until: Date; reason: string };

/** 요청을 보내도 되는지 판단한다 (예약 시점, 연결 행 잠금 안에서 호출). */
export function gate(state: BreakerState, now: Date): GateDecision {
  if (state.blockedUntil && state.blockedUntil.getTime() > now.getTime()) {
    return { allowed: false, until: state.blockedUntil, reason: state.blockReason ?? BLOCK_REASON.UPSTREAM_UNAVAILABLE };
  }
  if (state.backoffLevel > 0) {
    return {
      allowed: true,
      trial: true,
      next: { ...state, blockedUntil: new Date(now.getTime() + BREAKER_HALF_OPEN_HOLD_MS), blockReason: BLOCK_REASON.HALF_OPEN },
    };
  }
  return { allowed: true, trial: false };
}

/** level번째 백오프 시간: 5s → 10s → 20s … 최대 5분 */
export function backoffDelayMs(level: number): number {
  return Math.min(BREAKER_BACKOFF_BASE_MS * 2 ** Math.max(0, level - 1), BREAKER_BACKOFF_MAX_MS);
}

const isOpen = (state: BreakerState, now: Date) =>
  state.blockedUntil !== null && state.blockedUntil.getTime() > now.getTime() && state.blockReason !== BLOCK_REASON.HALF_OPEN;

/** 요청 결과를 반영한 다음 상태 (정산 시점, 연결 행 잠금 안에서 호출). */
export function afterResult(state: BreakerState, failure: FailureClass, now: Date, retryAfterMs: number | null = null): BreakerState {
  switch (failure) {
    case "NONE":
      // 정상 응답 → 실패 카운터·백오프 초기화 (닫힘)
      return CLOSED;

    case "RATE_LIMIT": {
      const consecutiveFailures = state.consecutiveFailures + 1;
      // 이미 열려 있는 동안 도착한 다른 요청의 429는 단계를 올리지 않는다 (동시 요청 때문에 백오프가 급격히 길어지는 것을 막음)
      const backoffLevel = isOpen(state, now) ? state.backoffLevel : state.backoffLevel + 1;
      const delay = retryAfterMs !== null && retryAfterMs > 0 ? Math.min(retryAfterMs, BREAKER_RETRY_AFTER_MAX_MS) : backoffDelayMs(backoffLevel);
      return { consecutiveFailures, backoffLevel, blockedUntil: later(state, now, delay), blockReason: BLOCK_REASON.RATE_LIMITED };
    }

    case "TRANSIENT": {
      const consecutiveFailures = state.consecutiveFailures + 1;
      // 연속 3회부터 백오프. 이미 백오프 중(반열림 시험 포함)이면 실패 즉시 다시 연다
      if (consecutiveFailures < BREAKER_TRANSIENT_FAILURE_THRESHOLD && state.backoffLevel === 0) {
        return { ...state, consecutiveFailures };
      }
      const backoffLevel = isOpen(state, now) ? state.backoffLevel : state.backoffLevel + 1;
      return { consecutiveFailures, backoffLevel, blockedUntil: later(state, now, backoffDelayMs(backoffLevel)), blockReason: BLOCK_REASON.UPSTREAM_UNAVAILABLE };
    }

    case "KEY":
    case "REQUEST":
      // 키 무효(연결 INVALID로 별도 차단)·요청 단위 오류는 일시 장애가 아니므로 카운터를 바꾸지 않는다.
      // 반열림 시험 요청이었다면 대기만 풀어 다음 요청이 다시 시험할 수 있게 한다
      return state.blockReason === BLOCK_REASON.HALF_OPEN ? { ...state, blockedUntil: null, blockReason: null } : state;
  }
}

/** 이미 열려 있으면 더 늦은 시각을 유지한다 */
function later(state: BreakerState, now: Date, delayMs: number): Date {
  const candidate = now.getTime() + delayMs;
  const current = isOpen(state, now) ? state.blockedUntil!.getTime() : 0;
  return new Date(Math.max(candidate, current));
}
