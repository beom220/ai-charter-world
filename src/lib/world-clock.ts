import { WORLD_DAY_SECONDS, WORLD_TIME_SCALE } from "../../config/limits";

// 월드 시간 순수 계산 (Phase 7-2-2). 클라이언트·서버 공용. 권위 있는 값은 서버의 GameState.worldSeconds + 정산 전 실행 구간이다.
// - 월드 시간은 RUNNING(보류 아님)으로 실제 진행한 시간 × 36만 흐른다. 장면 수와 별개의 축이다.
// - 표시: "Day N, HH:MM" (Day 0, 00:00에서 시작). 대화 화면은 시작일(세계관 생성일, KST 날짜) 00:00을 Day 0으로 두고
//   "yyyy-mm-dd hh:mm" 날짜·시각도 함께 보인다(세계관 달력과 무관한 표시용 날짜, 저장 값은 worldSeconds 그대로).

/** 실제 경과(ms) → 월드 경과(초, 내림) */
export const worldSecondsForRealMs = (ms: number): number => Math.floor((Math.max(0, ms) * WORLD_TIME_SCALE) / 1000);

/** 월드 경과(초)를 정산하는 데 쓴 실제 시간(ms, 내림). 나머지 실제 시간은 다음 정산으로 넘어가 버려지지 않는다 */
export const realMsForWorldSeconds = (seconds: number): number => Math.floor((seconds * 1000) / WORLD_TIME_SCALE);

export function formatWorldTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const day = Math.floor(s / WORLD_DAY_SECONDS);
  const rest = s % WORLD_DAY_SECONDS;
  const hh = String(Math.floor(rest / 3600)).padStart(2, "0");
  const mm = String(Math.floor((rest % 3600) / 60)).padStart(2, "0");
  return `Day ${day}, ${hh}:${mm}`;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 월드 시작일 "yyyy-mm-dd" = 세계관 생성 시각의 KST 날짜 (표시 기준일, Day 0) */
export const worldStartDate = (createdAt: Date): string => new Date(createdAt.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);

/** 시작일 기준 월드 날짜·시각: Day N(0부터)과 "yyyy-mm-dd hh:mm" */
export function worldCalendar(startDate: string, seconds: number): { day: number; dateTime: string } {
  const s = Math.max(0, Math.floor(seconds));
  const iso = new Date(Date.parse(`${startDate}T00:00:00.000Z`) + s * 1000).toISOString();
  return { day: Math.floor(s / WORLD_DAY_SECONDS), dateTime: `${iso.slice(0, 10)} ${iso.slice(11, 16)}` };
}

/** 서버가 알려 준 시각(asOf)의 월드 시간에서 지금(nowMs)까지 흐른 값. 멈춰 있으면 그대로 */
export function liveWorldSeconds(clock: { seconds: number; running: boolean; asOf: string }, nowMs: number): number {
  if (!clock.running) return clock.seconds;
  return clock.seconds + worldSecondsForRealMs(nowMs - Date.parse(clock.asOf));
}
