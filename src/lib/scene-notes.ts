// 대화 피드의 사건·상태 변화 메시지 표시 규칙 (Phase 7-4). 클라이언트·서버 공용 순수 로직, 단위 테스트한다.
// - 분류는 문구가 아니라 메시지 종류(kind)와 신체 상태 변화의 이전/이후 단계로 정한다. 사망은 언제나 death.
// - 표시 문구에서 기술적 접두어(시스템·사건 발생 등)를 화면에서만 걷어 낸다. 원본 기록은 바꾸지 않는다.

export type NoteKind = "EVENT_STARTED" | "USER_EVENT_STARTED" | "EVENT_RESOLVED" | "CONDITION" | "DEATH";
/** event = 사건(파랑), positive = 호전(초록), negative = 악화(주홍), death = 사망(검정) */
export type NoteTone = "event" | "positive" | "negative" | "death";
export type SceneNote = { kind: NoteKind; text: string; tone?: NoteTone };

// 단계 순위: 클수록 나쁨. 부상·고통·온도 불편 단계를 한 줄로 비교한다
const SEVERITY: Record<string, number> = { NONE: 0, MILD: 1, MODERATE: 2, SEVERE: 3, EXTREME: 4, CRITICAL: 4 };

/** 신체 상태 값(INJURY 단계, PAIN_<단계>, <원인>_<단계>)의 심각도. 알 수 없으면 null */
function severity(value: string): number | null {
  const level = value.startsWith("PAIN_") ? value.slice(5) : value.includes("_") ? value.slice(value.lastIndexOf("_") + 1) : value;
  return SEVERITY[level] ?? null;
}

/** 신체 상태 변화 한 건의 분류. 이전/이후 단계를 우선 비교하고, 같거나 알 수 없으면 변화 종류로 정한다 */
export function conditionTone(kind: string, fromValue: string, toValue: string): NoteTone {
  if (kind === "DEATH") return "death";
  const from = severity(fromValue);
  const to = severity(toValue);
  if (from !== null && to !== null && from !== to) return to < from ? "positive" : "negative";
  return kind === "TREATMENT" || kind === "RECOVERY" ? "positive" : "negative";
}

/** 메시지 분류. 사망은 다른 분류보다 우선한다 */
export function noteTone(note: SceneNote): NoteTone {
  if (note.kind === "DEATH" || note.tone === "death") return "death";
  if (note.tone) return note.tone;
  if (note.kind === "CONDITION") return "negative";
  return "event";
}

// 피드에 보이면 안 되는 기술적 접두어 (예전 기록·형식 대비)
const PREFIXES = ["시스템", "사용자가 일으킨 사건", "사건 발생", "새로운 사건", "세계의 변화"];
const PREFIX_RE = new RegExp(`^\\s*(?:${PREFIXES.join("|")})\\s*[:：·—-]\\s*`);

/** 표시 문구: 기술적 접두어를 (겹쳐 있어도) 모두 걷어 낸다. 본문이 비면 원문을 그대로 둔다 */
export function noteText(text: string): string {
  let out = text;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(PREFIX_RE, "");
  }
  return out.trim() || text;
}

/** 받침이 있으면 a(이), 없으면 b(가). 한글이 아니면 b */
export function josa(word: string, a: string, b: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0 ? a : b;
}
