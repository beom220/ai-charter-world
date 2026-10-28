import { z } from "zod";

// 시뮬레이션 실행 화면 순수 로직 (Phase 5-4-4). 클라이언트·서버 공용, DOM·React에 의존하지 않아 단위 테스트한다.
// - 상태의 기준은 서버 SimulationRuntime이다. 화면은 상태 API 응답과 SSE runtime.status를 그대로 반영하고 스스로 전이하지 않는다.
// - SSE 이벤트는 outbox 순서대로 오므로 마지막으로 받은 runtime.status가 현재 상태다.
// - 생성 중 표시는 scene.started로 켜고 scene.committed·scene.failed·inFlight=false인 runtime.status로 끈다.
// - 오류는 공개 코드만 받아 한국어 안내로 바꾼다. 캐릭터 발언과 섞지 않는다.

export const INTERVAL_PRESETS = ["SLOW", "NORMAL", "FAST"] as const;
export type IntervalPresetValue = (typeof INTERVAL_PRESETS)[number];
export const INTERVAL_LABEL: Record<IntervalPresetValue, string> = { SLOW: "느리게", NORMAL: "보통", FAST: "빠르게" };

const runtimeStatusSchema = z.enum(["IDLE", "RUNNING", "PAUSING", "PAUSED"]);
const statusReasonSchema = z.enum(["USER", "CLIENT_DISCONNECTED", "USAGE_LIMIT", "KEY_INVALID", "LOADED", "RESET", "SERVER_RECOVERY", "NOT_ENOUGH_CHARACTERS"]);

/**
 * 세계관·캐릭터 설정(생성·수정·삭제)을 바꿀 수 있는 실행 상태인가 (PRD FR-03·FR-04, 서버·화면 공용).
 * IDLE은 항상, PAUSED는 진행 중 장면이 없을 때만 허용한다. RUNNING·PAUSING은 거부한다.
 */
export function settingsEditable(state: { status: z.infer<typeof runtimeStatusSchema>; inFlight: boolean }): boolean {
  return state.status === "IDLE" || (state.status === "PAUSED" && !state.inFlight);
}

export const SETTINGS_LOCKED_MESSAGE = "대화가 실행 중이거나 진행 중인 장면이 있어 설정을 바꿀 수 없습니다. 대화를 일시정지·중지하고 진행 중인 장면이 끝난 뒤 수정하세요.";

/** GET /simulation/state·명령 응답·runtime.status payload (server/domain/simulation/control.ts readState) */
export const simulationStateSchema = z.object({
  status: runtimeStatusSchema,
  statusReason: statusReasonSchema.nullable(),
  runId: z.string().nullable(),
  intervalPreset: z.enum(INTERVAL_PRESETS),
  nextSceneAt: z.string().nullable(),
  inFlight: z.boolean(),
  held: z.boolean(),
  holdDeadline: z.string().nullable(),
  /** 월드 시간 (Phase 7-2-2): asOf 시각의 월드 누적 초, 흐르는 중인지 */
  worldClock: z.object({ seconds: z.number().int().min(0), running: z.boolean(), asOf: z.string() }),
});
export type SimulationStateView = z.infer<typeof simulationStateSchema>;

const sceneStartedSchema = z.object({ attemptId: z.string(), startedAt: z.string(), participants: z.array(z.string()) });
const sceneFailedSchema = z.object({ attemptId: z.string(), code: z.string() });

export type Generating = { attemptId: string | null; startedAt: number; participants: string[] };

export type SimulationView = {
  state: SimulationStateView;
  generating: Generating | null;
  /** 마지막 장면 실패 안내 (시스템 메시지) */
  failure: string | null;
};

export type SimEventName = "runtime.status" | "scene.started" | "scene.committed" | "scene.failed";

/** 처음 그릴 때. 진행 중 시도가 있으면 시작 시각을 모르므로 지금부터 센다 */
export function initialView(state: SimulationStateView, now: number): SimulationView {
  return { state, generating: state.inFlight ? { attemptId: null, startedAt: now, participants: [] } : null, failure: null };
}

/** 상태 API 응답(명령·재조회)을 반영한다 */
export function withState(view: SimulationView, state: SimulationStateView): SimulationView {
  return { ...view, state, generating: state.inFlight ? view.generating : null };
}

/** SSE 이벤트 1건을 반영한다. 형식이 다르면 그대로 둔다 */
export function applySimEvent(view: SimulationView, type: SimEventName, payload: unknown, now: number): SimulationView {
  switch (type) {
    case "runtime.status": {
      const parsed = simulationStateSchema.safeParse(payload);
      return parsed.success ? withState(view, parsed.data) : view;
    }
    case "scene.started": {
      const parsed = sceneStartedSchema.safeParse(payload);
      if (!parsed.success) return view;
      const startedAt = Date.parse(parsed.data.startedAt);
      return {
        ...view,
        generating: { attemptId: parsed.data.attemptId, startedAt: Number.isFinite(startedAt) ? Math.min(startedAt, now) : now, participants: parsed.data.participants },
        failure: null,
      };
    }
    case "scene.committed":
      return { ...view, generating: null, failure: null };
    case "scene.failed": {
      const parsed = sceneFailedSchema.safeParse(payload);
      if (!parsed.success) return view;
      const sameAttempt = view.generating?.attemptId == null || view.generating.attemptId === parsed.data.attemptId;
      return { ...view, generating: sameAttempt ? null : view.generating, failure: sceneFailureMessage(parsed.data.code) };
    }
  }
}

/** scene.failed 공개 코드 → 안내 문구. 사용자 동작(종료·일시정지)으로 끝난 시도는 알리지 않는다 */
export function sceneFailureMessage(code: string): string | null {
  switch (code) {
    case "STALE":
    case "ABORTED":
      return null;
    case "VALIDATION_ERROR":
      return "AI 응답 형식이 올바르지 않아 이번 장면을 건너뛰었습니다. 잠시 후 다음 장면을 시도합니다.";
    case "NETWORK_ERROR":
      return "Gemini 응답이 지연되거나 연결되지 않아 이번 장면을 건너뛰었습니다. 잠시 후 다음 장면을 시도합니다.";
    case "HTTP_ERROR":
      return "Gemini API 오류로 이번 장면을 건너뛰었습니다. 잠시 후 다음 장면을 시도합니다.";
    case "BACKOFF":
      return "Gemini API 오류가 이어져 잠시 쉬었다가 다시 시도합니다.";
    case "USAGE_LIMIT":
      return "오늘의 사용량 한도에 도달했습니다.";
    case "KEY_INVALID":
      return "Gemini 연결 상태를 확인해 주세요.";
    case "RESULT_LOST":
      return "서버가 다시 시작되어 진행 중이던 장면을 건너뛰었습니다.";
    default:
      return "장면을 만들지 못했습니다. 잠시 후 다음 장면을 시도합니다.";
  }
}

export type SimulationCommand = "start" | "pause" | "resume" | "stop";
export type ControlButton = { command: SimulationCommand; label: string } | { command: null; label: string };

/** 상태별 제어 버튼. command가 null이면 비활성 표시 */
export function controlsFor(status: SimulationStateView["status"]): ControlButton[] {
  switch (status) {
    case "IDLE":
      return [{ command: "start", label: "▶ 시작" }];
    case "RUNNING":
      return [
        { command: "pause", label: "⏸ 일시정지" },
        { command: "stop", label: "⏹ 종료" },
      ];
    case "PAUSING":
      return [
        { command: null, label: "일시정지 중…" },
        { command: "stop", label: "⏹ 종료" },
      ];
    case "PAUSED":
      return [
        { command: "resume", label: "▶ 재개" },
        { command: "stop", label: "⏹ 종료" },
      ];
  }
}

export type StatusNotice = { tone: "info" | "warn"; text: string; settingsLink?: boolean };

/** 실행 상태 안내 (연결 상태 안내는 별도) */
export function statusNotice(state: SimulationStateView): StatusNotice | null {
  if (state.status === "RUNNING" && state.held) {
    return { tone: "warn", text: "연결된 화면이 없어 새 장면 생성을 멈췄습니다. 1분 안에 연결이 복구되지 않으면 일시정지됩니다." };
  }
  if (state.status === "PAUSING") return { tone: "info", text: "진행 중인 장면을 마친 뒤 일시정지합니다." };
  if (state.status !== "PAUSED") return null;
  switch (state.statusReason) {
    case "CLIENT_DISCONNECTED":
      return { tone: "warn", text: "대화 화면을 벗어나거나 연결이 끊겨 시뮬레이션이 일시정지되었습니다. 재개를 눌러 계속하세요." };
    case "USAGE_LIMIT":
      return { tone: "warn", text: "오늘의 사용량 한도에 도달했습니다. 한도를 올리거나 자정(한국 시간) 이후에 재개하세요." };
    case "KEY_INVALID":
      return { tone: "warn", text: "Gemini 연결 상태를 확인해 주세요. 키 검증과 모델 선택 후 재개할 수 있습니다.", settingsLink: true };
    case "NOT_ENOUGH_CHARACTERS":
      return { tone: "warn", text: "대화할 수 있는 생존 캐릭터가 2명 미만이라 시뮬레이션을 멈췄습니다. 캐릭터를 추가하거나 이전 저장을 불러오세요." };
    default:
      return null;
  }
}
