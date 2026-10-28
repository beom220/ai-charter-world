// 실행 제어 명령의 상태 전이 규칙 (architecture.md §7.1·§7.2). 런타임 독립 순수 함수.
// - 이미 목표 상태면 noop(200 + 현재 상태, 멱등). 허용되지 않는 전이는 reject(409 INVALID_TRANSITION).
// - pause는 진행 중 장면이 있으면 PAUSING(완료 후 PAUSED), 없으면 바로 PAUSED. 진행 중 요청은 취소하지 않는다(D5).
// - stop은 IDLE로 보내고 stateVersion을 올린다(호출자가 처리). 그 전에 시작된 시도는 커밋 단계에서 거부된다.

export type RuntimeStatusValue = "IDLE" | "RUNNING" | "PAUSING" | "PAUSED";
export type SimulationCommand = "start" | "pause" | "resume" | "stop";

export type TransitionDecision =
  | { kind: "apply"; next: RuntimeStatusValue }
  | { kind: "noop" }
  | { kind: "reject" };

export function decideTransition(command: SimulationCommand, status: RuntimeStatusValue, inFlight: boolean): TransitionDecision {
  switch (command) {
    case "start":
      if (status === "IDLE") return { kind: "apply", next: "RUNNING" };
      return status === "RUNNING" ? { kind: "noop" } : { kind: "reject" };
    case "pause":
      if (status === "RUNNING") return { kind: "apply", next: inFlight ? "PAUSING" : "PAUSED" };
      return status === "PAUSING" || status === "PAUSED" ? { kind: "noop" } : { kind: "reject" };
    case "resume":
      if (status === "PAUSED") return { kind: "apply", next: "RUNNING" };
      return status === "RUNNING" ? { kind: "noop" } : { kind: "reject" };
    case "stop":
      return status === "IDLE" ? { kind: "noop" } : { kind: "apply", next: "IDLE" };
  }
}
