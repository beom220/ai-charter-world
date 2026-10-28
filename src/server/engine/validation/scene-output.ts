import { z } from "zod";
import { MEMORY_CONTENT_MAX_LENGTH, MEMORY_PER_OWNER_PER_SCENE, MEMORY_PER_SCENE_MAX, SCENE_TURNS_MIN } from "../../../../config/limits";
import type { MemoryAcquisition, MemoryKind, Mood } from "@/generated/prisma/client";
import { EVENT_DANGERS } from "../commit/event-rules";

// StoryMode 장면 출력 검증 (architecture.md §6.5 출력 스키마 v1, §6.6 SceneValidator). 런타임 독립 순수 모듈.
// LLM 출력은 제안일 뿐이다: 파싱·Zod·별칭 참조 검사를 모두 통과해야 장면 초안이 된다.
// proposals(감정·관계·기억, Phase 5-5):
// - 구조 오류, 이번 장면 매핑에 없는 별칭, 자기 자신과의 관계는 장면 실패다. 수치 상한·범위는 실패가 아니라 커밋 때 clamp한다.
// - 기억 소유자는 참가자(별칭)만 가능하다 = 그 장면을 직접 경험한 인물만 기억한다. 기억은 중요도 순으로 캐릭터당 2개·장면당 6개만 남긴다.
// - proposals가 없으면 상태 변화 없이 장면만 저장한다(빈 제안). 기억 획득 경로(acquisition)는 v1 스키마에 더한 선택 필드다.
// events·conditions(Phase 7-2-2, 선택 필드): 이번 장면 새 사건의 구체화·대체·위험(7-2-3, 해결 판정 없음)과 참가자의 온도·고통·부상·치료·사망 제안.
// - 없거나 형식이 틀려도 장면은 저장한다(사건은 미해결로 계속, 상태는 자연 변화만). 사건 별칭(E1…)이 이번 프롬프트에 없으면 그 항목만 버린다
//   (다른 사건을 잘못 종료하지 않는다). 상태 제안의 캐릭터는 참가자 별칭만 가능하다(사망자·비참가자는 발화·참조 불가).
// - 단계의 타당성(한 장면 상한·원인·치료 근거·사망 조건)은 커밋 때 engine/commit/condition-rules가 검증한다.
// - 위험(danger, 7-2-3)은 형식이 틀리면 NONE으로 둔다. 위험 인정은 engine/commit/event-rules가 판단한다.

export const SCENE_ALIASES = ["C1", "C2", "C3", "C4", "C5", "C6"] as const;
export type SceneAlias = (typeof SCENE_ALIASES)[number];
/** 프롬프트의 진행 중 사건 별칭 (DB ID 대신) */
export const EVENT_ALIASES = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9"] as const;
export type EventAlias = (typeof EVENT_ALIASES)[number];
const DISCOMFORT = ["NONE", "MILD", "SEVERE", "EXTREME"] as const;
const INJURY = ["NONE", "MILD", "MODERATE", "SEVERE", "CRITICAL"] as const;
const THERMAL_CAUSE = ["NONE", "COLD", "HEAT"] as const;

const END_REASONS = ["RESOLVED", "INTERRUPTED", "STALEMATE", "TURN_LIMIT"] as const;
export const MOODS = ["NEUTRAL", "HAPPY", "EXCITED", "CALM", "SAD", "ANXIOUS", "ANGRY", "FEARFUL", "EMBARRASSED", "LONELY", "HOPEFUL", "TIRED"] as const satisfies readonly Mood[];
export const MEMORY_KINDS = ["EVENT", "PROMISE", "CONFESSION", "CONFLICT", "SECRET", "IMPRESSION", "OTHER"] as const satisfies readonly MemoryKind[];
const ACQUISITIONS = ["WITNESSED", "TOLD", "OBSERVED"] as const satisfies readonly MemoryAcquisition[];

const cp = (max: number) => (s: string) => Array.from(s).length <= max;

const turnSchema = z.object({
  speaker: z.enum(SCENE_ALIASES),
  dialogue: z.string().trim().min(1).refine(cp(400)),
  actionIntent: z.string().trim().refine(cp(200)).nullable(),
  emotionCue: z.string().trim().refine(cp(40)).nullable(),
});

/** 변화량은 정수로 반올림한다. 상한·범위 초과는 실패가 아니라 커밋 때 clamp한다 (§6.6) */
const delta = z.number().finite().transform(Math.round);

const proposalsSchema = z.object({
  emotions: z
    .array(z.object({ character: z.enum(SCENE_ALIASES), mood: z.enum(MOODS), intensityDelta: delta }))
    .max(SCENE_ALIASES.length * 2)
    .default([]),
  relationships: z
    .array(
      z.object({
        from: z.enum(SCENE_ALIASES),
        to: z.enum(SCENE_ALIASES),
        affinity: delta,
        trust: delta,
        respect: delta,
        familiarity: delta,
        reason: z.string().trim().refine(cp(200)).nullable().default(null),
      }),
    )
    .max(SCENE_ALIASES.length * (SCENE_ALIASES.length - 1))
    .default([]),
  memories: z
    .array(
      z.object({
        owner: z.enum(SCENE_ALIASES),
        about: z.enum(SCENE_ALIASES).nullable(),
        kind: z.enum(MEMORY_KINDS),
        acquisition: z.enum(ACQUISITIONS).default("WITNESSED"),
        content: z.string().trim().min(1).refine(cp(MEMORY_CONTENT_MAX_LENGTH)),
        importance: delta, // 1..5 밖이면 clamp
      }),
    )
    .max(SCENE_ALIASES.length * 4)
    .default([]),
});

const reason = z.string().trim().refine(cp(200));

// 해결 판정 필드(status·resolutionSummary·resolutionKind, 7-2-3에서 폐지)가 와도 버린다 (z.object는 모르는 키를 지운다)
const eventOutcomeSchema = z.object({
  ref: z.string(),
  /** 새 사건을 이 세계관에 맞게 구체화한 문구 */
  realization: z.string().trim().refine(cp(200)).nullable().default(null),
  /** 생물이 불가능한 세계관이라 대체 사건으로 썼는가 */
  usedFallback: z.boolean().default(false),
  /** 이번 장면에서 이 사건으로 실제 일어난 신체 위험 (7-2-3). 사용자 사건의 고강도 악화 허용 근거 */
  danger: z.enum(EVENT_DANGERS).catch("NONE").default("NONE"),
});

const conditionProposalSchema = z.object({
  character: z.enum(SCENE_ALIASES),
  thermal: z.object({ cause: z.enum(THERMAL_CAUSE), level: z.enum(DISCOMFORT) }).nullable().default(null),
  pain: z.object({ level: z.enum(DISCOMFORT), cause: reason.nullable().default(null) }).nullable().default(null),
  injury: z.object({ level: z.enum(INJURY), cause: reason }).nullable().default(null),
  treatment: reason.nullable().default(null),
  death: z.object({ cause: reason }).nullable().default(null),
  eventRef: z.string().nullable().default(null),
});

const sceneOutputSchema = (maxTurns: number) =>
  z.object({
    scene: z.object({
      title: z.string().trim().min(1).refine(cp(60)),
      summary: z.string().trim().min(1).refine(cp(300)),
      endReason: z.enum(END_REASONS),
    }),
    turns: z.array(turnSchema).min(SCENE_TURNS_MIN).max(maxTurns),
    proposals: proposalsSchema.default({ emotions: [], relationships: [], memories: [] }),
    // 형식이 틀린 선택 필드는 장면 실패 대신 비운다 (사건·상태는 서버 기본값으로 계속)
    events: z.array(eventOutcomeSchema).max(EVENT_ALIASES.length).catch([]).default([]),
    conditions: z.array(conditionProposalSchema).max(SCENE_ALIASES.length).catch([]).default([]),
  });

export type SceneOutput = z.infer<ReturnType<typeof sceneOutputSchema>>;
export type SceneProposals = SceneOutput["proposals"];
export type SceneEventOutcome = SceneOutput["events"][number];
export type SceneConditionProposal = SceneOutput["conditions"][number];

/** Gemini responseJsonSchema (Zod 스키마와 같은 구조. 최종 판정은 서버의 Zod 검증이다) */
export function sceneResponseJsonSchema(aliases: readonly SceneAlias[], maxTurns: number, eventAliases: readonly EventAlias[] = []): Record<string, unknown> {
  const nullableString = (maxLength: number) => ({ type: ["string", "null"], maxLength });
  return {
    type: "object",
    properties: {
      scene: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 60 },
          summary: { type: "string", maxLength: 300 },
          endReason: { type: "string", enum: [...END_REASONS] },
        },
        required: ["title", "summary", "endReason"],
      },
      turns: {
        type: "array",
        minItems: SCENE_TURNS_MIN,
        maxItems: maxTurns,
        items: {
          type: "object",
          properties: {
            speaker: { type: "string", enum: [...aliases] },
            dialogue: { type: "string", maxLength: 400 },
            actionIntent: nullableString(200),
            emotionCue: nullableString(40),
          },
          required: ["speaker", "dialogue", "actionIntent", "emotionCue"],
        },
      },
      proposals: {
        type: "object",
        properties: {
          emotions: {
            type: "array",
            items: {
              type: "object",
              properties: { character: { type: "string", enum: [...aliases] }, mood: { type: "string", enum: [...MOODS] }, intensityDelta: { type: "integer" } },
              required: ["character", "mood", "intensityDelta"],
            },
          },
          relationships: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string", enum: [...aliases] },
                to: { type: "string", enum: [...aliases] },
                affinity: { type: "integer" },
                trust: { type: "integer" },
                respect: { type: "integer" },
                familiarity: { type: "integer" },
                reason: nullableString(200),
              },
              required: ["from", "to", "affinity", "trust", "respect", "familiarity", "reason"],
            },
          },
          memories: {
            type: "array",
            maxItems: MEMORY_PER_SCENE_MAX,
            items: {
              type: "object",
              properties: {
                owner: { type: "string", enum: [...aliases] },
                about: { type: ["string", "null"], enum: [...aliases, null] },
                kind: { type: "string", enum: [...MEMORY_KINDS] },
                acquisition: { type: "string", enum: [...ACQUISITIONS] },
                content: { type: "string", maxLength: MEMORY_CONTENT_MAX_LENGTH },
                importance: { type: "integer", minimum: 1, maximum: 5 },
              },
              required: ["owner", "about", "kind", "acquisition", "content", "importance"],
            },
          },
        },
        required: ["emotions", "relationships", "memories"],
      },
      ...(eventAliases.length
        ? {
            events: {
              type: "array",
              maxItems: eventAliases.length,
              items: {
                type: "object",
                properties: {
                  ref: { type: "string", enum: [...eventAliases] },
                  realization: nullableString(200),
                  usedFallback: { type: "boolean" },
                  danger: { type: "string", enum: [...EVENT_DANGERS] },
                },
                required: ["ref", "realization", "usedFallback", "danger"],
              },
            },
          }
        : {}),
      conditions: {
        type: "array",
        maxItems: aliases.length,
        items: {
          type: "object",
          properties: {
            character: { type: "string", enum: [...aliases] },
            thermal: {
              type: ["object", "null"],
              properties: { cause: { type: "string", enum: [...THERMAL_CAUSE] }, level: { type: "string", enum: [...DISCOMFORT] } },
              required: ["cause", "level"],
            },
            pain: { type: ["object", "null"], properties: { level: { type: "string", enum: [...DISCOMFORT] }, cause: nullableString(200) }, required: ["level", "cause"] },
            injury: { type: ["object", "null"], properties: { level: { type: "string", enum: [...INJURY] }, cause: { type: "string", maxLength: 200 } }, required: ["level", "cause"] },
            treatment: nullableString(200),
            death: { type: ["object", "null"], properties: { cause: { type: "string", maxLength: 200 } }, required: ["cause"] },
            eventRef: { type: ["string", "null"], enum: [...eventAliases, null] },
          },
          required: ["character", "thermal", "pain", "injury", "treatment", "death", "eventRef"],
        },
      },
    },
    required: ["scene", "turns", "proposals"],
  };
}

/** 검증 실패 사유 (로그용 고정 코드. LLM 출력 원문은 담지 않는다) */
export class SceneValidationError extends Error {
  constructor(readonly reason: "INVALID_JSON" | "SCHEMA" | "UNKNOWN_SPEAKER" | "SINGLE_SPEAKER" | "UNKNOWN_REFERENCE" | "SELF_RELATIONSHIP") {
    super(`장면 검증 실패: ${reason}`);
    this.name = "SceneValidationError";
  }
}

/**
 * 응답 텍스트 → 검증된 장면. 구조 오류·턴 수 위반·이번 장면 매핑에 없는 별칭은 모두 실패다(§6.6). clamp 대상 수치는 아직 없다.
 * 대화 장면이므로 발화자가 2명 이상이어야 한다.
 */
export function parseSceneOutput(text: string, aliases: readonly SceneAlias[], maxTurns: number): SceneOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SceneValidationError("INVALID_JSON");
  }
  const parsed = sceneOutputSchema(maxTurns).safeParse(raw);
  if (!parsed.success) throw new SceneValidationError("SCHEMA");
  const allowed = new Set<string>(aliases);
  if (parsed.data.turns.some((t) => !allowed.has(t.speaker))) throw new SceneValidationError("UNKNOWN_SPEAKER");
  if (new Set(parsed.data.turns.map((t) => t.speaker)).size < 2) throw new SceneValidationError("SINGLE_SPEAKER");

  const { emotions, relationships, memories } = parsed.data.proposals;
  const refs = [
    ...emotions.map((e) => e.character),
    ...relationships.flatMap((r) => [r.from, r.to]),
    ...memories.flatMap((m) => (m.about ? [m.owner, m.about] : [m.owner])),
  ];
  if (refs.some((a) => !allowed.has(a))) throw new SceneValidationError("UNKNOWN_REFERENCE"); // 비참가자·세계관 밖 참조
  // 상태 제안: 참가자만 (사망자·비참가자 참조는 장면 실패. 사망자는 참가자가 아니므로 발화도 위 UNKNOWN_SPEAKER로 막힌다)
  if (parsed.data.conditions.some((c) => !allowed.has(c.character))) throw new SceneValidationError("UNKNOWN_REFERENCE");
  // 같은 캐릭터 상태 제안·같은 사건 결과는 첫 항목만 (같은 상태를 두 번 바꾸지 않게)
  const conditions = parsed.data.conditions.filter((c, i, all) => all.findIndex((x) => x.character === c.character) === i);
  const events = parsed.data.events.filter((e, i, all) => all.findIndex((x) => x.ref === e.ref) === i);
  if (relationships.some((r) => r.from === r.to)) throw new SceneValidationError("SELF_RELATIONSHIP");
  return { ...parsed.data, events, conditions, proposals: { emotions, relationships, memories: selectMemories(memories) } };
}

/** 중요도 높은 순(같으면 제안 순)으로 캐릭터당 2개·장면당 6개만 남긴다. 자기 자신에 대한 인물 기억은 about을 비운다 */
function selectMemories(memories: SceneProposals["memories"]): SceneProposals["memories"] {
  const perOwner = new Map<string, number>();
  const kept: SceneProposals["memories"] = [];
  const ranked = memories.map((m, i) => ({ m, i })).sort((a, b) => b.m.importance - a.m.importance || a.i - b.i);
  for (const { m } of ranked) {
    if (kept.length >= MEMORY_PER_SCENE_MAX) break;
    const n = perOwner.get(m.owner) ?? 0;
    if (n >= MEMORY_PER_OWNER_PER_SCENE) continue;
    perOwner.set(m.owner, n + 1);
    kept.push(m.about === m.owner ? { ...m, about: null } : m);
  }
  return kept;
}
