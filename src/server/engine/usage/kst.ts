// 일일 사용량 날짜는 Asia/Seoul(KST) 기준이다 (A9, database.md §1-9). 저장 시각(timestamp)은 UTC 그대로 둔다.
// KST는 서머타임이 없으므로 UTC+9 고정 오프셋으로 계산한다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** now가 속한 KST 날짜를 `@db.Date` 컬럼에 넣을 값(UTC 자정 Date)으로 돌려준다. */
export function kstDate(now: Date): Date {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** 다음 KST 자정(UTC 시각). 한도 도달 안내에 쓴다. */
export function nextKstMidnight(now: Date): Date {
  return new Date(kstDate(now).getTime() + 24 * 60 * 60 * 1000 - KST_OFFSET_MS);
}
