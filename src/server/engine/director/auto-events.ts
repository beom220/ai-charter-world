import {
  AUTO_EVENT_CHANCE,
  AUTO_EVENT_FIRST_SCENE_SEQ,
  AUTO_EVENT_PERIOD_SCENES,
  AUTO_EVENT_RECENT_PRESET_EXCLUDE,
} from "../../../../config/limits";
import { EVENT_PRESETS, type EventCategory } from "../../../../config/world-events";

// 자동 사건 구간 추첨·프리셋 선택 (Phase 7-2 명세 §2). 런타임 독립 순수 함수. 난수는 호출자가 넘긴다(테스트 가능).
// - 구간: #3~#22 = 0, #23~#42 = 1 … 구간마다 정확히 한 번 40%로 추첨하고, 당첨되면 구간 안 장면 하나를 균등하게 예약한다.
//   장면마다 추첨하지 않는다. 추첨 결과의 영속화(구간당 1행)는 domain/events/auto-periods.ts가 한다.
// - 프리셋: 최근 8개 프리셋 ID와 직전 범주를 빼고 균등 추첨한다. 후보가 없으면 직전 범주 제외 → 최근 ID 제외 → 직전 ID 제외 순으로 완화한다.

export type AutoEventPeriod = { index: number; startSeq: number; endSeq: number };

/** 장면 번호가 속한 구간. 첫 판정 장면(#3) 전이면 null */
export function autoEventPeriodOf(sceneSeq: number): AutoEventPeriod | null {
  if (sceneSeq < AUTO_EVENT_FIRST_SCENE_SEQ) return null;
  const index = Math.floor((sceneSeq - AUTO_EVENT_FIRST_SCENE_SEQ) / AUTO_EVENT_PERIOD_SCENES);
  const startSeq = AUTO_EVENT_FIRST_SCENE_SEQ + index * AUTO_EVENT_PERIOD_SCENES;
  return { index, startSeq, endSeq: startSeq + AUTO_EVENT_PERIOD_SCENES - 1 };
}

/**
 * 구간 추첨 1회. random()은 [0, 1). 첫 값으로 당첨(< 40%)을 정하고, 당첨이면 둘째 값으로 예약 장면을 고른다.
 * fromSeq를 주면(구간 중간에 처음 판정하는 경우: 불러오기·기존 진행 세계관) 그 장면 이후에서만 예약한다.
 */
export function rollAutoEventPeriod(period: AutoEventPeriod, random: () => number, fromSeq = period.startSeq): { won: boolean; scheduledSceneSeq: number | null } {
  const won = random() < AUTO_EVENT_CHANCE;
  if (!won) return { won: false, scheduledSceneSeq: null };
  const start = Math.min(Math.max(fromSeq, period.startSeq), period.endSeq);
  const span = period.endSeq - start + 1;
  return { won: true, scheduledSceneSeq: start + Math.min(span - 1, Math.floor(random() * span)) };
}

/** 최근 사건 (최신 → 오래된 순) */
export type RecentEvent = { presetId: string | null; category: EventCategory | null };

/** 반복을 피해 프리셋 하나를 고른다. 후보가 고갈되면 단계적으로 제한을 완화한다 (항상 하나를 돌려준다) */
export function pickAutoEventPreset(recent: RecentEvent[], random: () => number): string {
  const recentIds = new Set(recent.slice(0, AUTO_EVENT_RECENT_PRESET_EXCLUDE).flatMap((e) => (e.presetId ? [e.presetId] : [])));
  const lastCategory = recent[0]?.category ?? null;
  const lastId = recent[0]?.presetId ?? null;
  const stages = [
    EVENT_PRESETS.filter((p) => !recentIds.has(p.id) && p.category !== lastCategory),
    EVENT_PRESETS.filter((p) => !recentIds.has(p.id)),
    EVENT_PRESETS.filter((p) => p.id !== lastId),
    EVENT_PRESETS,
  ];
  const pool = stages.find((s) => s.length > 0)!;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!.id;
}
