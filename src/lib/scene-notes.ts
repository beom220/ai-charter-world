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

// ── 발언자 이름 옆 감정 표시(emotionCue). 모델이 영어(ANXIOUS, nervous, slightly worried 등)로 낸 값을 화면에서만 한국어로 바꾼다.
// 아는 영어 감정은 한국어로, 모르는 영어 단어는 숨긴다(한국어가 섞인 조각은 그대로 둔다). 원본 기록은 바꾸지 않는다.
const EMOTION_KO: Record<string, string> = {
  neutral: "평온", happy: "기쁨", excited: "들뜸", calm: "차분", sad: "슬픔", anxious: "불안", angry: "분노", fearful: "두려움",
  embarrassed: "당황", lonely: "외로움", hopeful: "기대", tired: "지침",
  joy: "기쁨", joyful: "기쁨", cheerful: "명랑", glad: "기쁨", delighted: "기쁨", sadness: "슬픔", anger: "분노", fear: "두려움",
  afraid: "두려움", scared: "겁먹음", terrified: "공포", panic: "공포", panicked: "공포", nervous: "긴장", tense: "긴장",
  uneasy: "불안", worried: "걱정", worry: "걱정", concerned: "걱정", curious: "궁금함", surprised: "놀람", surprise: "놀람",
  shocked: "충격", confused: "혼란", determined: "단호함", resolute: "단호함", firm: "단호함", relieved: "안도", frustrated: "답답함",
  annoyed: "짜증", irritated: "짜증", playful: "장난스러움", serious: "진지함", gentle: "다정함", warm: "따뜻함", cold: "냉담",
  suspicious: "의심", cautious: "조심스러움", hesitant: "망설임", thoughtful: "생각에 잠김", pensive: "생각에 잠김", sarcastic: "비꼼",
  desperate: "절박함", urgent: "다급함", grateful: "고마움", guilty: "죄책감", ashamed: "부끄러움", shy: "수줍음", proud: "자부심",
  jealous: "질투", disappointed: "실망", bored: "지루함", amused: "재미있어함", hurt: "상처받음", pained: "고통", painful: "고통",
  exhausted: "지침", sleepy: "졸림", encouraging: "격려", reassuring: "안심시킴", hope: "기대", love: "애정", loving: "애정",
  affectionate: "애정", friendly: "친근함", sincere: "진심", defiant: "반항", resigned: "체념", bitter: "씁쓸함",
};
const EMOTION_DEGREE: Record<string, string> = { slightly: "약간", somewhat: "약간", mildly: "약간", little: "약간", bit: "약간", very: "매우", extremely: "매우", deeply: "매우", really: "매우", quite: "꽤" };
const HANGUL = /[가-힣]/;

function emotionPart(part: string): string | null {
  if (HANGUL.test(part)) return part.trim();
  const words = part.toLowerCase().replace(/[_-]+/g, " ").match(/[a-z]+/g) ?? [];
  const degree = words.map((w) => EMOTION_DEGREE[w]).find(Boolean);
  const feelings = words.map((w) => EMOTION_KO[w]).filter((k): k is string => !!k);
  if (!feelings.length) return null;
  return `${degree ? `${degree} ` : ""}${feelings.join("·")}`;
}

/** 감정 표시 문구. 보여 줄 것이 없으면 null */
export function emotionCueText(cue: string | null): string | null {
  if (!cue?.trim()) return null;
  const parts = cue.split(/\s*(?:[,/&;·]|\band\b|\bwith\b)\s*/i).filter((p) => p.trim());
  const out = [...new Set(parts.map(emotionPart).filter((p): p is string => !!p))];
  return out.length ? out.join(", ") : null;
}
