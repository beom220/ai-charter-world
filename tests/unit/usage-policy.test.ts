import { describe, expect, it } from "vitest";
import {
  BREAKER_BACKOFF_BASE_MS,
  BREAKER_BACKOFF_MAX_MS,
  BREAKER_HALF_OPEN_HOLD_MS,
  BREAKER_RETRY_AFTER_MAX_MS,
  BREAKER_TRANSIENT_FAILURE_THRESHOLD,
} from "../../config/limits";
import { afterResult, backoffDelayMs, BLOCK_REASON, CLOSED, gate, type BreakerState } from "@/server/engine/usage/breaker";
import { kstDate, nextKstMidnight } from "@/server/engine/usage/kst";
import { failureClassOf, outcomeOf, usageStatusOf } from "@/server/engine/usage/metering";
import type { GeminiCallRecord } from "@/server/llm/gemini/client";

// 사용량 정책의 순수 로직: KST 날짜, 서킷 브레이커 상태 전이, 결과·사용량 분류 (DB 불필요)

const at = (iso: string) => new Date(iso);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

describe("KST 날짜", () => {
  it("UTC 14:59:59.999는 KST 같은 날 23:59:59.999, UTC 15:00은 KST 다음 날", () => {
    expect(kstDate(at("2026-10-28T14:59:59.999Z")).toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(kstDate(at("2026-10-28T15:00:00.000Z")).toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });

  it("UTC 기준 전날 저녁이라도 KST로는 다음 날이다", () => {
    // UTC 10-27 20:00 = KST 10-28 05:00
    expect(kstDate(at("2026-10-27T20:00:00Z")).toISOString()).toBe("2026-10-28T00:00:00.000Z");
  });

  it("월·연 경계", () => {
    expect(kstDate(at("2026-12-31T15:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(kstDate(at("2027-02-28T15:30:00Z")).toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });

  it("다음 KST 자정은 UTC 15:00", () => {
    expect(nextKstMidnight(at("2026-10-28T03:00:00Z")).toISOString()).toBe("2026-10-28T15:00:00.000Z");
    expect(nextKstMidnight(at("2026-10-28T14:59:59.999Z")).toISOString()).toBe("2026-10-28T15:00:00.000Z");
    expect(nextKstMidnight(at("2026-10-28T15:00:00Z")).toISOString()).toBe("2026-10-29T15:00:00.000Z");
  });
});

describe("서킷 브레이커", () => {
  const now = at("2026-10-28T03:00:00Z");

  it("백오프 시간: 5s → 10s → 20s … 최대 5분", () => {
    expect([1, 2, 3, 4].map(backoffDelayMs)).toEqual([BREAKER_BACKOFF_BASE_MS, BREAKER_BACKOFF_BASE_MS * 2, BREAKER_BACKOFF_BASE_MS * 4, BREAKER_BACKOFF_BASE_MS * 8]);
    expect(backoffDelayMs(30)).toBe(BREAKER_BACKOFF_MAX_MS);
  });

  it("429는 첫 실패부터 백오프하고, 실패할 때마다 단계가 오른다", () => {
    const s1 = afterResult(CLOSED, "RATE_LIMIT", now);
    expect(s1).toEqual({ consecutiveFailures: 1, backoffLevel: 1, blockedUntil: plus(now, BREAKER_BACKOFF_BASE_MS), blockReason: BLOCK_REASON.RATE_LIMITED });
    const later = plus(now, BREAKER_BACKOFF_BASE_MS);
    const s2 = afterResult(s1, "RATE_LIMIT", later);
    expect(s2.backoffLevel).toBe(2);
    expect(s2.blockedUntil).toEqual(plus(later, BREAKER_BACKOFF_BASE_MS * 2));
  });

  it("429 응답의 retryDelay가 있으면 그 값을 우선하고, 비정상적으로 길면 상한으로 자른다", () => {
    expect(afterResult(CLOSED, "RATE_LIMIT", now, 37_000).blockedUntil).toEqual(plus(now, 37_000));
    expect(afterResult(CLOSED, "RATE_LIMIT", now, 10 * BREAKER_RETRY_AFTER_MAX_MS).blockedUntil).toEqual(plus(now, BREAKER_RETRY_AFTER_MAX_MS));
  });

  it("이미 열린 동안 도착한 다른 요청의 429는 단계를 올리지 않는다 (동시 요청)", () => {
    const open = afterResult(CLOSED, "RATE_LIMIT", now);
    const again = afterResult(open, "RATE_LIMIT", plus(now, 100));
    expect(again.backoffLevel).toBe(1);
    expect(again.blockedUntil!.getTime()).toBeGreaterThanOrEqual(open.blockedUntil!.getTime());
  });

  it(`5xx·네트워크·시간 초과는 연속 ${BREAKER_TRANSIENT_FAILURE_THRESHOLD}회부터 백오프`, () => {
    let s: BreakerState = CLOSED;
    for (let i = 1; i < BREAKER_TRANSIENT_FAILURE_THRESHOLD; i++) {
      s = afterResult(s, "TRANSIENT", now);
      expect(s).toMatchObject({ consecutiveFailures: i, backoffLevel: 0, blockedUntil: null });
      expect(gate(s, now).allowed).toBe(true);
    }
    s = afterResult(s, "TRANSIENT", now);
    expect(s).toMatchObject({ consecutiveFailures: BREAKER_TRANSIENT_FAILURE_THRESHOLD, backoffLevel: 1, blockReason: BLOCK_REASON.UPSTREAM_UNAVAILABLE });
    expect(s.blockedUntil).toEqual(plus(now, BREAKER_BACKOFF_BASE_MS));
  });

  it("열림 → 거부, 시간이 지나면 시험 요청 1건만 허용(반열림), 시험 중 다른 요청은 거부", () => {
    const open = afterResult(CLOSED, "RATE_LIMIT", now);
    const blocked = gate(open, plus(now, 1000));
    expect(blocked).toMatchObject({ allowed: false, reason: BLOCK_REASON.RATE_LIMITED });

    const after = plus(open.blockedUntil!, 1);
    const trial = gate(open, after);
    expect(trial).toMatchObject({ allowed: true, trial: true });
    if (!trial.allowed || !trial.trial) throw new Error("unreachable");
    expect(trial.next).toMatchObject({ blockReason: BLOCK_REASON.HALF_OPEN, blockedUntil: plus(after, BREAKER_HALF_OPEN_HOLD_MS) });
    expect(gate(trial.next, plus(after, 10))).toMatchObject({ allowed: false, reason: BLOCK_REASON.HALF_OPEN });
  });

  it("시험 요청 성공 → 닫힘(카운터 초기화), 실패 → 더 긴 백오프로 다시 열림", () => {
    const open = afterResult(CLOSED, "RATE_LIMIT", now);
    const after = plus(open.blockedUntil!, 1);
    const trial = gate(open, after);
    if (!trial.allowed || !trial.trial) throw new Error("unreachable");

    expect(afterResult(trial.next, "NONE", after)).toEqual(CLOSED);
    const reopened = afterResult(trial.next, "TRANSIENT", after);
    expect(reopened).toMatchObject({ backoffLevel: 2, blockReason: BLOCK_REASON.UPSTREAM_UNAVAILABLE, blockedUntil: plus(after, BREAKER_BACKOFF_BASE_MS * 2) });
  });

  it("성공하면 연속 실패 카운터가 초기화된다 (임계 전)", () => {
    const s = afterResult(afterResult(CLOSED, "TRANSIENT", now), "TRANSIENT", now);
    expect(afterResult(s, "NONE", now)).toEqual(CLOSED);
  });

  it("키 무효·요청 단위 오류는 브레이커를 바꾸지 않고, 시험 요청이었으면 대기만 푼다", () => {
    const s = afterResult(CLOSED, "TRANSIENT", now);
    expect(afterResult(s, "KEY", now)).toEqual(s);
    expect(afterResult(s, "REQUEST", now)).toEqual(s);

    const open = afterResult(CLOSED, "RATE_LIMIT", now);
    const trial = gate(open, plus(open.blockedUntil!, 1));
    if (!trial.allowed || !trial.trial) throw new Error("unreachable");
    expect(afterResult(trial.next, "REQUEST", now)).toMatchObject({ backoffLevel: 1, blockedUntil: null, blockReason: null });
  });
});

describe("결과·사용량 분류", () => {
  const base: Pick<GeminiCallRecord, "operation" | "httpStatus" | "errorKind" | "usage"> = { operation: "models.generateContent", httpStatus: 200, errorKind: null, usage: null };

  it("실패 종류: 429 = RATE_LIMIT, 5xx·네트워크·시간 초과 = TRANSIENT, 키 무효 = KEY(영구), 그 밖 = REQUEST", () => {
    expect(failureClassOf(null)).toBe("NONE");
    expect(failureClassOf("QUOTA_EXCEEDED")).toBe("RATE_LIMIT");
    for (const k of ["UPSTREAM_ERROR", "TIMEOUT", "NETWORK_ERROR"] as const) expect(failureClassOf(k)).toBe("TRANSIENT");
    expect(failureClassOf("KEY_INVALID")).toBe("KEY");
    for (const k of ["PERMISSION_DENIED", "MODEL_NOT_FOUND", "BAD_REQUEST", "INCOMPLETE_RESPONSE"] as const) expect(failureClassOf(k)).toBe("REQUEST");
  });

  it("사용량 상태: 사용량이 없을 때 0으로 단정하지 않는다", () => {
    expect(usageStatusOf({ ...base, usage: { inputTokens: 2, outputTokens: 14, thoughtTokens: null } })).toBe("REPORTED");
    expect(usageStatusOf(base)).toBe("MISSING"); // 200인데 usageMetadata 없음
    expect(usageStatusOf({ ...base, httpStatus: 503, errorKind: "UPSTREAM_ERROR" })).toBe("UNKNOWN");
    expect(usageStatusOf({ ...base, httpStatus: null, errorKind: "TIMEOUT" })).toBe("UNKNOWN");
    expect(usageStatusOf({ ...base, httpStatus: 429, errorKind: "QUOTA_EXCEEDED" })).toBe("NOT_APPLICABLE"); // 생성 전 거부
    expect(usageStatusOf({ ...base, operation: "models.list" })).toBe("NOT_APPLICABLE");
  });

  it("outcome: 200 미완료 = VALIDATION_ERROR, HTTP 상태 없는 시간 초과 = NETWORK_ERROR", () => {
    expect(outcomeOf({ errorKind: null, httpStatus: 200 })).toBe("SUCCESS");
    expect(outcomeOf({ errorKind: "INCOMPLETE_RESPONSE", httpStatus: 200 })).toBe("VALIDATION_ERROR");
    expect(outcomeOf({ errorKind: "TIMEOUT", httpStatus: null })).toBe("NETWORK_ERROR");
    expect(outcomeOf({ errorKind: "TIMEOUT", httpStatus: 504 })).toBe("HTTP_ERROR");
    expect(outcomeOf({ errorKind: "QUOTA_EXCEEDED", httpStatus: 429 })).toBe("HTTP_ERROR");
  });
});
