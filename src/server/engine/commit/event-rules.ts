// 사건 결과 검증 규칙 (Phase 7-2-3). 런타임 독립 순수 함수. 장면 커밋 트랜잭션이 결과만 저장한다.
// - 해결(RESOLVED): 결과 종류(resolutionKind)와 결과 요약이 모두 있어야 하고, 요약이 발생·발견·계획·시도만 말하면(결과 표현 없이) 받지 않는다.
//   새 사건은 저강도(LOW)일 때만 첫 장면에 해결될 수 있다(고강도·중강도 새 사건은 첫 장면에 끝내지 않는다). 받지 않으면 진행 중(ACTIVE)으로 둔다.
// - 위험 확인(danger): 사용자 사건은 기본 MEDIUM이다. 이번 장면 결과가 그 사건으로 실제 공격·재난·사고 피해를 보고하고(danger ≠ NONE),
//   캐릭터의 상태 제안이 그 사건을 원인으로 가리킬 때만 그 캐릭터에게 고강도(HIGH) 악화 한도를 허용한다.
//   위험이 확인되지 않은 사용자 사건(방문·소식·발견 등)을 원인으로 한 부상·사망 제안은 받지 않는다 → 그 사건만으로 위독·사망이 생기지 않는다.

export const RESOLUTION_KINDS = ["SOLVED", "MITIGATED", "FAILED", "COMPROMISE", "THREAT_GONE"] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];
export const EVENT_DANGERS = ["NONE", "ATTACK", "DISASTER", "ACCIDENT"] as const;
export type EventDanger = (typeof EVENT_DANGERS)[number];

/** 결과가 아니라 발생·발견·계획·시도만 나타내는 표현 */
const NOT_YET = /(발견|발생|나타났|나타난|등장|목격|들려왔|소식|논의|의논|고민)/;
/** 계획·시도·미래 표현이 담긴 어절 (예: 해결하기로, 고치려고, 구조를 시도했다, 해결할) — 결과 표현 검사에서 뺀다 */
const PLAN_WORD = /(기로|려고|려던|려는|계획|예정|시도|준비|할$|하겠|겠다|겠지|을까|할까)/;
/** 실제 결과를 나타내는 표현 (해결·완화·실패·타협·위협 소멸 등) */
const OUTCOME =
  /(해결했|해결됐|해결되었|해결된|끝났|끝냈|마무리됐|마무리했|마무리되|사라졌|물리쳤|쫓아냈|쫓아 냈|쫓아버렸|막아냈|막았|고쳤|수리했|복구했|복구됐|복구되|구했|구조했|되찾았|확보했|합의했|합의에 이르|타협했|타협을 봤|화해했|실패했|실패로|실패하고|포기했|포기하고|잃었|진정됐|진정되었|진정시켰|회복했|회복됐|회복되었|떠났|돌아갔|무사히|넘겼|잦아들었|그쳤|멈췄|해소됐|해소되었|해소했|치웠|피했|대피했|봉쇄했|완료했|완료됐|완료되)/;

export type EventOutcomeInput = { status: "ONGOING" | "RESOLVED"; resolutionSummary: string | null; resolutionKind: ResolutionKind | null };

/** 이번 장면에서 이 사건을 해결로 받아들이는가 */
export function acceptResolution(outcome: EventOutcomeInput | undefined, event: { isNew: boolean; intensity: "LOW" | "MEDIUM" | "HIGH" | null }): boolean {
  if (outcome?.status !== "RESOLVED" || !outcome.resolutionKind) return false;
  const summary = outcome.resolutionSummary?.trim();
  if (!summary) return false;
  if (event.isNew && event.intensity !== "LOW") return false;
  // 계획·시도 어절을 빼고도 결과 표현이 남아야 한다. 발생·발견·계획·시도 표현이 전혀 없으면 결과 종류(resolutionKind)를 믿는다
  const words = summary.split(/\s+/);
  const kept = words.filter((w) => !PLAN_WORD.test(w)).join(" ");
  const mentionsNotYet = NOT_YET.test(summary) || kept.length < words.join(" ").length;
  return !mentionsNotYet || OUTCOME.test(kept);
}

/** 장면 결과가 보고한 실제 위험(공격·재난·사고)인가 */
export const dangerConfirmed = (danger: EventDanger | null | undefined): boolean => !!danger && danger !== "NONE";
