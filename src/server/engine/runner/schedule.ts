import { RUNNER_FAILURE_BACKOFF_MAX_MS, RUNNER_FAILURE_BACKOFF_MIN_MS, SCENE_INTERVAL_MS, SCENE_PLAYBACK_TIMING } from "../../../../config/limits";

// 다음 장면 예약 시각 계산 (architecture.md §6.3 10단계, Phase 5-4-2). 런타임 독립 순수 함수.
// - 성공: 저장 완료 시각 + max(설정 간격, 예상 재생 시간). 브라우저 재생 완료 신호는 기다리지 않고 서버가 보수적으로 추정한다.
// - 실패: 설정 간격(최소 5초)에서 연속 실패마다 두 배, 상한 5분. 같은 요청을 다시 보내지 않으며 다음 시도는 새 장면이다.
// - 브레이커 열림: max(설정 간격, blockedUntil).

export type IntervalPresetValue = keyof typeof SCENE_INTERVAL_MS;

/** 발언 수만큼 "쉼 + 입력 중…" 최대 시간을 더한다 (lib/scene-feed.ts 재생 큐의 최악값) */
export function estimatePlaybackMs(turns: number): number {
  return turns * (SCENE_PLAYBACK_TIMING.gapMs[1] + SCENE_PLAYBACK_TIMING.typingMs[1]);
}

export function nextSceneAfterCommit(committedAt: Date, preset: IntervalPresetValue, turns: number): Date {
  return new Date(committedAt.getTime() + Math.max(SCENE_INTERVAL_MS[preset], estimatePlaybackMs(turns)));
}

export function nextSceneAfterFailure(failedAt: Date, preset: IntervalPresetValue, consecutiveFailures: number): Date {
  const base = Math.max(SCENE_INTERVAL_MS[preset], RUNNER_FAILURE_BACKOFF_MIN_MS);
  const delay = Math.min(RUNNER_FAILURE_BACKOFF_MAX_MS, base * 2 ** Math.max(0, consecutiveFailures - 1));
  return new Date(failedAt.getTime() + delay);
}

export function nextSceneAfterBackoff(now: Date, preset: IntervalPresetValue, blockedUntil: Date): Date {
  return new Date(Math.max(now.getTime() + SCENE_INTERVAL_MS[preset], blockedUntil.getTime()));
}
