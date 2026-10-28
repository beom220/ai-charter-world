import { describe, expect, it } from "vitest";
import { planEmotionChanges, planRelationshipChanges } from "@/server/engine/commit/state-changes";
import { buildStoryPrompt, type PromptCharacter } from "@/server/engine/context/story-prompt";
import { parseSceneOutput, SceneValidationError } from "@/server/engine/validation/scene-output";

// 감정·관계·기억 제안 (Phase 5-5): 검증(참조·자기 관계·기억 개수), clamp(감정 ±20, 관계 ±5, 범위), 프롬프트 반영.

const turns = ["C1", "C2", "C1"].map((speaker) => ({ speaker, dialogue: "대사", actionIntent: null, emotionCue: null }));
const output = (proposals: unknown) => JSON.stringify({ scene: { title: "t", summary: "s", endReason: "RESOLVED" }, turns, proposals });
const memory = (owner: string, importance: number, content = `${owner}-${importance}`) => ({ owner, about: null, kind: "EVENT", acquisition: "WITNESSED", content, importance });

describe("제안 검증", () => {
  it("proposals가 없으면 빈 제안, 참가자가 아닌 별칭·자기 관계는 장면 실패", () => {
    expect(parseSceneOutput(output(undefined), ["C1", "C2"], 6).proposals).toEqual({ emotions: [], relationships: [], memories: [] });
    const bad = (p: unknown) => () => parseSceneOutput(output(p), ["C1", "C2"], 6);
    expect(bad({ emotions: [{ character: "C3", mood: "HAPPY", intensityDelta: 5 }] })).toThrow(SceneValidationError);
    expect(bad({ memories: [memory("C3", 3)] })).toThrow(expect.objectContaining({ reason: "UNKNOWN_REFERENCE" }));
    expect(bad({ relationships: [{ from: "C1", to: "C1", affinity: 1, trust: 0, respect: 0, familiarity: 0, reason: null }] })).toThrow(
      expect.objectContaining({ reason: "SELF_RELATIONSHIP" }),
    );
  });

  it("기억은 중요도 순으로 캐릭터당 2개·장면당 6개만 남긴다", () => {
    const parsed = parseSceneOutput(output({ memories: [memory("C1", 1), memory("C1", 5), memory("C1", 3), memory("C2", 2)] }), ["C1", "C2"], 6);
    expect(parsed.proposals.memories.map((m) => m.content)).toEqual(["C1-5", "C1-3", "C2-2"]);
  });
});

describe("clamp", () => {
  it("감정: 합산 후 ±20, 0..100 범위", () => {
    const [up] = planEmotionChanges([{ character: "C1", mood: "HAPPY", intensityDelta: 50 }], () => ({ mood: "NEUTRAL", intensity: 50 }));
    expect(up).toMatchObject({ to: { mood: "HAPPY", intensity: 70 }, dIntensity: 20, proposedDelta: 50, clamped: true });
    const [edge] = planEmotionChanges([{ character: "C1", mood: "SAD", intensityDelta: -15 }], () => ({ mood: "NEUTRAL", intensity: 10 }));
    expect(edge).toMatchObject({ to: { intensity: 0 }, dIntensity: -10, clamped: true });
    const [ok] = planEmotionChanges([{ character: "C2", mood: "CALM", intensityDelta: 7 }], () => ({ mood: "NEUTRAL", intensity: 50 }));
    expect(ok).toMatchObject({ dIntensity: 7, clamped: false });
  });

  it("관계: 같은 쌍은 합산 후 축별 ±5, 범위(친밀 0..100) clamp", () => {
    const p = (affinity: number, familiarity: number) => ({ from: "C1" as const, to: "C2" as const, affinity, trust: 2, respect: 0, familiarity, reason: "이유" });
    const [plan] = planRelationshipChanges([p(4, -3), p(4, 0)], () => ({ affinity: 0, trust: 0, respect: 0, familiarity: 1 }));
    expect(plan).toMatchObject({ applied: { affinity: 5, trust: 4, respect: 0, familiarity: -1 }, proposed: { affinity: 8, trust: 4, familiarity: -3 }, clamped: true });
    expect(plan!.after.familiarity).toBe(0);
  });
});

describe("프롬프트", () => {
  it("참가자의 관계와 소유자 라벨이 붙은 기억을 넣는다", () => {
    const base: Omit<PromptCharacter, "alias" | "name"> = {
      gender: "FEMALE",
      genderCustom: null,
      age: 20,
      personalityTags: [],
      bigFive: { extraversion: 50, agreeableness: 50, conscientiousness: 50, emotionalStability: 50, openness: 50 },
      goal: null,
      characterContext: "",
      mood: "HAPPY",
      moodIntensity: 70,
    };
    const { prompt, systemInstruction } = buildStoryPrompt({ name: "w", worldRules: null, currentSituation: null, worldContext: "" }, [
      {
        ...base,
        alias: "C1",
        name: "가람",
        relations: [{ toAlias: "C2", toName: "나래", affinity: 5, trust: 3, respect: 0, familiarity: 2 }],
        memories: [{ content: "나래와 등대에 가기로 약속했다", kind: "PROMISE", acquisition: "WITNESSED", importance: 4, aboutName: "나래" }],
      },
      { ...base, alias: "C2", name: "나래" },
    ], 6);
    expect(prompt).toContain("현재 감정: HAPPY (강도 70/100)");
    expect(prompt).toContain("- C2 나래: 호감 5, 신뢰 3, 존중 0, 친밀 2");
    expect(prompt).toContain("[C1만 아는 기억]");
    expect(prompt).toContain("나래와 등대에 가기로 약속했다");
    expect(prompt).not.toContain("[C2만 아는 기억]");
    expect(systemInstruction).toContain("proposals");
  });
});
