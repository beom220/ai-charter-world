import { z } from "zod";
import { SCENE_TURNS_MIN } from "../../../../config/limits";

// StoryMode 장면 출력 검증 (architecture.md §6.5 출력 스키마 v1, §6.6 SceneValidator). 런타임 독립 순수 모듈.
// Phase 5-1은 scene·turns만 요청·반영한다. proposals(감정·관계·기억)는 엔진 단계에서 추가한다.
// LLM 출력은 제안일 뿐이다: 파싱·Zod·별칭 참조 검사를 모두 통과해야 장면 초안이 된다.

export const SCENE_ALIASES = ["C1", "C2", "C3", "C4", "C5", "C6"] as const;
export type SceneAlias = (typeof SCENE_ALIASES)[number];

const END_REASONS = ["RESOLVED", "INTERRUPTED", "STALEMATE", "TURN_LIMIT"] as const;

const cp = (max: number) => (s: string) => Array.from(s).length <= max;

const turnSchema = z.object({
  speaker: z.enum(SCENE_ALIASES),
  dialogue: z.string().trim().min(1).refine(cp(400)),
  actionIntent: z.string().trim().refine(cp(200)).nullable(),
  emotionCue: z.string().trim().refine(cp(40)).nullable(),
});

const sceneOutputSchema = (maxTurns: number) =>
  z.object({
    scene: z.object({
      title: z.string().trim().min(1).refine(cp(60)),
      summary: z.string().trim().min(1).refine(cp(300)),
      endReason: z.enum(END_REASONS),
    }),
    turns: z.array(turnSchema).min(SCENE_TURNS_MIN).max(maxTurns),
  });

export type SceneOutput = z.infer<ReturnType<typeof sceneOutputSchema>>;

/** Gemini responseJsonSchema (Zod 스키마와 같은 구조. 최종 판정은 서버의 Zod 검증이다) */
export function sceneResponseJsonSchema(aliases: readonly SceneAlias[], maxTurns: number): Record<string, unknown> {
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
    },
    required: ["scene", "turns"],
  };
}

/** 검증 실패 사유 (로그용 고정 코드. LLM 출력 원문은 담지 않는다) */
export class SceneValidationError extends Error {
  constructor(readonly reason: "INVALID_JSON" | "SCHEMA" | "UNKNOWN_SPEAKER" | "SINGLE_SPEAKER") {
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
  return parsed.data;
}
