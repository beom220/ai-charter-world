import { describe, expect, it } from "vitest";
import { estimatePlaybackMs, nextSceneAfterBackoff, nextSceneAfterCommit, nextSceneAfterFailure } from "@/server/engine/runner/schedule";

// 다음 장면 예약 (Phase 5-4-2): max(설정 간격, 예상 재생 시간), 실패 시 두 배 간격, 브레이커 열림 시 blockedUntil.
const t0 = new Date("2026-10-28T00:00:00.000Z");
const after = (d: Date) => d.getTime() - t0.getTime();

describe("다음 장면 예약 계산", () => {
  it("재생 시간이 간격보다 길면 재생 시간을, 짧으면 설정 간격을 쓴다", () => {
    expect(estimatePlaybackMs(3)).toBe(3 * (900 + 3_000));
    expect(after(nextSceneAfterCommit(t0, "FAST", 3))).toBe(11_700);
    expect(after(nextSceneAfterCommit(t0, "NORMAL", 6))).toBe(23_400);
    expect(after(nextSceneAfterCommit(t0, "SLOW", 3))).toBe(15_000);
  });

  it("연속 실패는 최소 5초에서 두 배씩 늘고 5분에서 멈춘다. 브레이커는 blockedUntil까지 기다린다", () => {
    expect([1, 2, 3].map((n) => after(nextSceneAfterFailure(t0, "FAST", n)))).toEqual([5_000, 10_000, 20_000]);
    expect(after(nextSceneAfterFailure(t0, "SLOW", 1))).toBe(15_000);
    expect(after(nextSceneAfterFailure(t0, "NORMAL", 20))).toBe(300_000);
    expect(after(nextSceneAfterBackoff(t0, "NORMAL", new Date(t0.getTime() + 60_000)))).toBe(60_000);
    expect(after(nextSceneAfterBackoff(t0, "SLOW", new Date(t0.getTime() + 1_000)))).toBe(15_000);
  });
});
