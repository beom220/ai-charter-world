import { describe, expect, it } from "vitest";
import { applySimEvent, controlsFor, initialView, sceneFailureMessage, statusNotice, type SimulationStateView } from "@/lib/simulation-view";

// 실행 화면 상태 (Phase 5-4-4): 버튼, SSE 이벤트 반영, 안내 문구. 서버 상태만 반영하고 스스로 전이하지 않는다.
const base: SimulationStateView = {
  status: "IDLE",
  statusReason: null,
  runId: null,
  intervalPreset: "NORMAL",
  nextSceneAt: null,
  inFlight: false,
  held: false,
  holdDeadline: null,
};
const running = { ...base, status: "RUNNING" as const, statusReason: "USER" as const, runId: "run-1" };

describe("시뮬레이션 실행 화면", () => {
  it("상태별 제어 버튼", () => {
    const labels = (s: SimulationStateView["status"]) => controlsFor(s).map((c) => [c.command, c.label]);
    expect(labels("IDLE")).toEqual([["start", "▶ 시작"]]);
    expect(labels("RUNNING")).toEqual([["pause", "⏸ 일시정지"], ["stop", "⏹ 종료"]]);
    expect(labels("PAUSING")).toEqual([[null, "일시정지 중…"], ["stop", "⏹ 종료"]]);
    expect(labels("PAUSED")).toEqual([["resume", "▶ 재개"], ["stop", "⏹ 종료"]]);
  });

  it("scene.started → 생성 중, scene.committed·같은 시도의 scene.failed → 해제. 속도·상태는 runtime.status로 바뀐다", () => {
    let v = initialView(running, 1_000);
    v = applySimEvent(v, "scene.started", { worldId: "w", attemptId: "a1", startedAt: new Date(500).toISOString(), participants: ["가람", "나래"] }, 1_000);
    expect(v.generating).toEqual({ attemptId: "a1", startedAt: 500, participants: ["가람", "나래"] });
    expect(applySimEvent(v, "scene.committed", { scene: {} }, 2_000).generating).toBeNull();

    const failed = applySimEvent(v, "scene.failed", { worldId: "w", attemptId: "a1", failedAt: "x", code: "HTTP_ERROR" }, 2_000);
    expect(failed.generating).toBeNull();
    expect(failed.failure).toContain("이번 장면을 건너뛰었습니다");
    expect(applySimEvent(v, "scene.failed", { attemptId: "other", code: "HTTP_ERROR" }, 2_000).generating?.attemptId).toBe("a1");

    v = applySimEvent(v, "runtime.status", { ...running, intervalPreset: "FAST", inFlight: false }, 3_000);
    expect(v.state.intervalPreset).toBe("FAST");
    expect(v.generating).toBeNull();
    expect(applySimEvent(v, "runtime.status", { status: "BOGUS" }, 3_000)).toBe(v); // 형식이 다르면 무시
  });

  it("새로고침 시 진행 중이면 생성 중으로 시작하고, 사용자 동작으로 끝난 시도·내부 코드는 그대로 보이지 않는다", () => {
    expect(initialView({ ...running, inFlight: true }, 42).generating).toEqual({ attemptId: null, startedAt: 42, participants: [] });
    expect(sceneFailureMessage("STALE")).toBeNull();
    expect(sceneFailureMessage("ABORTED")).toBeNull();
    expect(sceneFailureMessage("SOMETHING_INTERNAL")).not.toContain("SOMETHING_INTERNAL");
  });

  it("연결 보류·자동 일시정지 사유 안내", () => {
    expect(statusNotice({ ...running, held: true })?.text).toContain("연결된 화면이 없어");
    expect(statusNotice({ ...base, status: "PAUSED", statusReason: "CLIENT_DISCONNECTED" })?.text).toContain("연결이 끊겨 시뮬레이션이 일시정지");
    expect(statusNotice({ ...base, status: "PAUSED", statusReason: "USAGE_LIMIT" })?.text).toContain("사용량 한도");
    expect(statusNotice({ ...base, status: "PAUSED", statusReason: "KEY_INVALID" })).toMatchObject({ settingsLink: true });
    expect(statusNotice({ ...base, status: "PAUSED", statusReason: "USER" })).toBeNull();
    expect(statusNotice(running)).toBeNull();
  });
});
