import { WORLD_DAY_SECONDS, WORLD_TIME_SCALE } from "../../config/limits";

// 월드 시간 순수 계산 (Phase 7-2-2). 클라이언트·서버 공용. 권위 있는 값은 서버의 GameState.worldSeconds + 정산 전 실행 구간이다.
// - 월드 시간은 RUNNING(보류 아님)으로 실제 진행한 시간 × 36만 흐른다. 장면 수와 별개의 축이다.
// - 표시는 세계관 달력을 강요하지 않도록 단순한 "Day N, HH:MM" (Day 1, 00:00에서 시작).

/** 실제 경과(ms) → 월드 경과(초, 내림) */
export const worldSecondsForRealMs = (ms: number): number => Math.floor((Math.max(0, ms) * WORLD_TIME_SCALE) / 1000);

/** 월드 경과(초)를 정산하는 데 쓴 실제 시간(ms, 내림). 나머지 실제 시간은 다음 정산으로 넘어가 버려지지 않는다 */
export const realMsForWorldSeconds = (seconds: number): number => Math.floor((seconds * 1000) / WORLD_TIME_SCALE);

export function formatWorldTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const day = Math.floor(s / WORLD_DAY_SECONDS) + 1;
  const rest = s % WORLD_DAY_SECONDS;
  const hh = String(Math.floor(rest / 3600)).padStart(2, "0");
  const mm = String(Math.floor((rest % 3600) / 60)).padStart(2, "0");
  return `Day ${day}, ${hh}:${mm}`;
}

/** 서버가 알려 준 시각(asOf)의 월드 시간에서 지금(nowMs)까지 흐른 값. 멈춰 있으면 그대로 */
export function liveWorldSeconds(clock: { seconds: number; running: boolean; asOf: string }, nowMs: number): number {
  if (!clock.running) return clock.seconds;
  return clock.seconds + worldSecondsForRealMs(nowMs - Date.parse(clock.asOf));
}
