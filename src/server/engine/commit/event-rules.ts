// 사건 위험 확인 규칙 (Phase 7-2-3). 런타임 독립 순수 함수.
// 사건은 장면에 한 번 일어나는 상황이며 해결 여부를 판정하지 않는다.
// 위험 확인(danger): 사용자 사건은 기본 MEDIUM이다. 이번 장면 결과가 그 사건으로 실제 공격·재난·사고 피해를 보고하고(danger ≠ NONE),
// 캐릭터의 상태 제안이 그 사건을 원인으로 가리킬 때만 그 캐릭터에게 고강도(HIGH) 악화 한도를 허용한다.
// 위험이 확인되지 않은 사용자 사건(방문·소식·발견 등)을 원인으로 한 부상·사망 제안은 받지 않는다 → 그 사건만으로 위독·사망이 생기지 않는다.

export const EVENT_DANGERS = ["NONE", "ATTACK", "DISASTER", "ACCIDENT"] as const;
export type EventDanger = (typeof EVENT_DANGERS)[number];

/** 장면 결과가 보고한 실제 위험(공격·재난·사고)인가 */
export const dangerConfirmed = (danger: EventDanger | null | undefined): boolean => !!danger && danger !== "NONE";
