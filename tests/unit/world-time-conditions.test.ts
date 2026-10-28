import { describe, expect, it } from "vitest";
import { EXTREME_LETHAL_WORLD_SECONDS, EXTREME_LIFE_RISK_WORLD_SECONDS } from "../../config/limits";
import { conditionBadges, painLabel, thermalLabel } from "@/lib/condition-labels";
import { formatWorldTime, liveWorldSeconds, realMsForWorldSeconds, worldSecondsForRealMs } from "@/lib/world-clock";
import { DEFAULT_CONDITION_STATE, planConditionChange, type ConditionProposal, type ConditionState } from "@/server/engine/commit/condition-rules";
import { parseSceneOutput, SceneValidationError } from "@/server/engine/validation/scene-output";

// Phase 7-2-2: 월드 시간 배율(실제 1시간 = 월드 36시간), 표시, 온도 불편·고통 단계 표시, 상태 규칙(악화 상한·치료·자연 회복·극심 지속·사망),
// 장면 응답의 선택 필드(events·conditions) 검증.

const HOUR = 3600;
const base: ConditionState = DEFAULT_CONDITION_STATE;
const none: ConditionProposal = { thermal: null, pain: null, injury: null, treatment: null, death: null };
const ctx = (nowSeconds: number, highIntensityEvent = false) => ({ nowSeconds, sceneSeq: 5, highIntensityEvent });

describe("월드 시간", () => {
  it("실제 1시간 = 월드 36시간(1.5일), 실제 1초 = 36초, 월드 1일 = 실제 40분. 나머지 실제 시간은 버리지 않는다", () => {
    expect(worldSecondsForRealMs(60 * 60 * 1000)).toBe(36 * HOUR);
    expect(worldSecondsForRealMs(1000)).toBe(36);
    expect(worldSecondsForRealMs(40 * 60 * 1000)).toBe(24 * HOUR);
    expect(worldSecondsForRealMs(27)).toBe(0); // 27ms < 월드 1초 → 다음 정산으로 넘어간다
    expect(realMsForWorldSeconds(36)).toBe(1000);
    expect(formatWorldTime(0)).toBe("Day 1, 00:00");
    expect(formatWorldTime(36 * HOUR)).toBe("Day 2, 12:00");
    expect(formatWorldTime(24 * HOUR - 60)).toBe("Day 1, 23:59");
  });

  it("화면 계산: 흐르는 중이면 asOf 이후 실제 시간 × 36을 더하고, 멈춰 있으면 그대로", () => {
    const asOf = "2026-10-28T00:00:00.000Z";
    const t = Date.parse(asOf) + 10_000;
    expect(liveWorldSeconds({ seconds: 100, running: true, asOf }, t)).toBe(460);
    expect(liveWorldSeconds({ seconds: 100, running: false, asOf }, t)).toBe(100);
  });
});

describe("신체 상태 표시", () => {
  it("온도는 원인(추움·더움)과 단계(경미·심함·극심), 고통은 독립 단계, 사망은 사망만", () => {
    expect(thermalLabel("COLD", "MILD")).toBe("추움(경미)");
    expect(thermalLabel("HEAT", "EXTREME")).toBe("더움(극심)");
    expect(thermalLabel("NONE", "NONE")).toBe("정상");
    expect(painLabel("SEVERE")).toBe("고통(심함)");
    expect(conditionBadges({ thermalCause: "HEAT", thermalLevel: "SEVERE", painLevel: "MILD", injury: "MODERATE", vital: "ALIVE" })).toEqual(["더움(심함)", "고통(경미)", "부상 아픔"]);
    expect(conditionBadges({ thermalCause: "COLD", thermalLevel: "EXTREME", painLevel: "EXTREME", injury: "CRITICAL", vital: "DEAD" })).toEqual(["사망"]);
  });
});

describe("상태 규칙", () => {
  it("온도: 한 장면에 한 단계씩 악화(고강도 사건이면 두 단계), 개선도 한 단계씩, 반대 원인은 경미 이하에서만 바뀐다", () => {
    const cold = (level: "MILD" | "SEVERE" | "EXTREME") => ({ ...none, thermal: { cause: "COLD" as const, level } });
    expect(planConditionChange(base, cold("EXTREME"), ctx(0)).next).toMatchObject({ thermalCause: "COLD", thermalLevel: "MILD", thermalSinceSeconds: 0 });
    expect(planConditionChange(base, cold("EXTREME"), ctx(0, true)).next.thermalLevel).toBe("SEVERE");
    const severe = { ...base, thermalCause: "COLD" as const, thermalLevel: "SEVERE" as const, thermalSinceSeconds: 0 };
    expect(planConditionChange(severe, { ...none, thermal: { cause: "NONE", level: "NONE" } }, ctx(10)).next).toMatchObject({ thermalCause: "COLD", thermalLevel: "MILD" });
    expect(planConditionChange(severe, { ...none, thermal: { cause: "HEAT", level: "SEVERE" } }, ctx(10)).next).toMatchObject({ thermalCause: "COLD", thermalLevel: "SEVERE" });
    const mild = { ...severe, thermalLevel: "MILD" as const };
    expect(planConditionChange(mild, { ...none, thermal: { cause: "HEAT", level: "SEVERE" } }, ctx(10)).next).toMatchObject({ thermalCause: "HEAT", thermalLevel: "MILD" });
    // 제안이 없으면 시간만으로는 바뀌지 않는다
    expect(planConditionChange(severe, null, ctx(1000 * HOUR)).changes).toEqual([]);
  });

  it("부상: 원인 없는 제안은 무시, 한 장면 상한, 위독은 고강도 사건이나 이미 매우 아픔일 때만. 새 부상은 최소 고통을 남긴다", () => {
    expect(planConditionChange(base, { ...none, injury: { level: "SEVERE", cause: " " } }, ctx(0)).changes).toEqual([]);
    expect(planConditionChange(base, { ...none, injury: { level: "SEVERE", cause: "낙상" } }, ctx(0)).next).toMatchObject({ injury: "MILD", injuryCause: "낙상", injurySceneSeq: 5 });
    const severe = planConditionChange(base, { ...none, injury: { level: "CRITICAL", cause: "곰의 공격" } }, ctx(0, true)).next;
    expect(severe).toMatchObject({ injury: "MODERATE", painLevel: "MILD", painCause: "곰의 공격" });
    const fromSevere = { ...base, injury: "SEVERE" as const, injuryCause: "x", injuryUpdatedAtSeconds: 0 };
    expect(planConditionChange(fromSevere, { ...none, injury: { level: "CRITICAL", cause: "출혈" } }, ctx(10)).next.injury).toBe("CRITICAL");
    const fromModerate = { ...fromSevere, injury: "MODERATE" as const };
    expect(planConditionChange(fromModerate, { ...none, injury: { level: "CRITICAL", cause: "출혈" } }, ctx(10)).next.injury).toBe("SEVERE");
  });

  it("치료는 실제 수행 결과가 있을 때만 한 단계, 고통 완화도 치료 때만. 치료한 장면에는 자연 회복을 겹쳐 적용하지 않는다", () => {
    const hurt = { ...base, injury: "MODERATE" as const, injuryCause: "x", injuryUpdatedAtSeconds: 0, painLevel: "SEVERE" as const, painCause: "x", painSinceSeconds: 0 };
    expect(planConditionChange(hurt, { ...none, pain: { level: "NONE", cause: null } }, ctx(HOUR)).next.painLevel).toBe("SEVERE");
    const treated = planConditionChange(hurt, { ...none, treatment: "상처를 소독하고 부목을 댔다" }, ctx(100 * HOUR));
    expect(treated.next).toMatchObject({ injury: "MILD", painLevel: "MILD", injuryUpdatedAtSeconds: 100 * HOUR });
    expect(treated.changes.map((c) => c.kind)).toEqual(["TREATMENT", "TREATMENT"]); // 72시간이 지났지만 자연 회복은 없음
  });

  it("자연 회복은 월드 시간 기준: 약간 아픔 24시간·아픔 72시간 뒤 한 단계, 위독은 나아지지 않는다. 고통은 12시간마다 부상이 남기는 하한까지", () => {
    const mild = { ...base, injury: "MILD" as const, injuryCause: "x", injuryUpdatedAtSeconds: 0 };
    expect(planConditionChange(mild, null, ctx(24 * HOUR - 1)).changes).toEqual([]);
    expect(planConditionChange(mild, null, ctx(24 * HOUR)).next).toMatchObject({ injury: "NONE", injuryCause: null });
    const critical = { ...base, injury: "CRITICAL" as const, injuryCause: "x", injuryUpdatedAtSeconds: 0, extremeSinceSeconds: 0 };
    expect(planConditionChange(critical, null, ctx(30 * HOUR)).next.injury).toBe("CRITICAL");
    const pain = { ...base, injury: "MODERATE" as const, injuryCause: "x", injuryUpdatedAtSeconds: 0, painLevel: "SEVERE" as const, painCause: "x", painSinceSeconds: 0 };
    expect(planConditionChange(pain, null, ctx(12 * HOUR)).next.painLevel).toBe("MILD");
    expect(planConditionChange({ ...pain, painLevel: "MILD" }, null, ctx(48 * HOUR)).next.painLevel).toBe("MILD"); // 아픔 부상의 하한
  });

  it("극심 지속: 진입 즉시·무작위 사망 없음, 12시간 뒤 생명 위험이면 제안된 사망 수용, 48시간이면 서버가 확정, 극심이 풀리면 누적 해제", () => {
    const extreme = { ...base, thermalCause: "COLD" as const, thermalLevel: "EXTREME" as const, thermalSinceSeconds: 0, extremeSinceSeconds: 0 };
    const death = { ...none, death: { cause: "얼어 죽음" } };
    expect(planConditionChange({ ...extreme, extremeSinceSeconds: null }, death, ctx(0)).next).toMatchObject({ vital: "ALIVE", extremeSinceSeconds: 0 });
    expect(planConditionChange(extreme, death, ctx(EXTREME_LIFE_RISK_WORLD_SECONDS - 1)).next.vital).toBe("ALIVE");
    expect(planConditionChange(extreme, death, ctx(EXTREME_LIFE_RISK_WORLD_SECONDS)).next).toMatchObject({ vital: "DEAD", deathCause: "얼어 죽음", deathSceneSeq: 5 });
    expect(planConditionChange(extreme, null, ctx(EXTREME_LETHAL_WORLD_SECONDS - 1)).next.vital).toBe("ALIVE");
    expect(planConditionChange(extreme, null, ctx(EXTREME_LETHAL_WORLD_SECONDS)).next).toMatchObject({ vital: "DEAD", deathCause: "극심한 추위가 오래 이어짐" });
    // 대피로 한 단계 개선 → 극심 해제 → 누적 사라짐
    const warmed = planConditionChange(extreme, { ...none, thermal: { cause: "NONE", level: "NONE" } }, ctx(EXTREME_LETHAL_WORLD_SECONDS - 10)).next;
    expect(warmed).toMatchObject({ thermalLevel: "SEVERE", extremeSinceSeconds: null, vital: "ALIVE" });
  });

  it("치명적 장면: 고강도 사건 중 이번 장면에서 위독이 되면 제안된 사망을 받아들이고, 그 밖의 근거 없는 사망 제안은 무시. 사망 뒤에는 바뀌지 않는다", () => {
    const severe = { ...base, injury: "SEVERE" as const, injuryCause: "x", injuryUpdatedAtSeconds: 0 };
    const fatal = { ...none, injury: { level: "CRITICAL" as const, cause: "호랑이에게 물림" }, death: { cause: "호랑이 습격" } };
    expect(planConditionChange(severe, fatal, ctx(10, true)).next.vital).toBe("DEAD");
    expect(planConditionChange(severe, fatal, ctx(10, false)).next).toMatchObject({ vital: "ALIVE", injury: "CRITICAL" });
    expect(planConditionChange(base, { ...none, death: { cause: "갑자기" } }, ctx(10, true)).next.vital).toBe("ALIVE");
    const dead = { ...base, vital: "DEAD" as const, deathCause: "x", deathSceneSeq: 1, deathWorldSeconds: 0 };
    expect(planConditionChange(dead, { ...none, treatment: "치료" }, ctx(10))).toEqual({ next: dead, changes: [] });
  });
});

describe("장면 응답의 사건·상태 필드", () => {
  const turns = [
    { speaker: "C1", dialogue: "a", actionIntent: null, emotionCue: null },
    { speaker: "C2", dialogue: "b", actionIntent: null, emotionCue: null },
    { speaker: "C1", dialogue: "c", actionIntent: null, emotionCue: null },
  ];
  const json = (extra: Record<string, unknown> = {}) => JSON.stringify({ scene: { title: "t", summary: "s", endReason: "RESOLVED" }, turns, ...extra });

  it("없거나 형식이 틀리면 장면은 그대로 두고 비우며, 같은 캐릭터·사건의 중복 항목은 첫 것만 남긴다", () => {
    expect(parseSceneOutput(json(), ["C1", "C2"], 6)).toMatchObject({ events: [], conditions: [] });
    expect(parseSceneOutput(json({ events: "bad", conditions: [{ character: "C1", thermal: 3 }] }), ["C1", "C2"], 6)).toMatchObject({ events: [], conditions: [] });
    const out = parseSceneOutput(
      json({
        events: [
          { ref: "E1", status: "RESOLVED", resolutionSummary: "쫓아냄", realization: null, usedFallback: false },
          { ref: "E1", status: "ONGOING", resolutionSummary: null, realization: null, usedFallback: false },
        ],
        conditions: [
          { character: "C1", thermal: { cause: "COLD", level: "MILD" }, pain: null, injury: null, treatment: null, death: null, eventRef: "E1" },
          { character: "C1", thermal: null, pain: null, injury: null, treatment: null, death: { cause: "x" }, eventRef: null },
        ],
      }),
      ["C1", "C2"],
      6,
    );
    expect(out.events).toHaveLength(1);
    expect(out.conditions).toEqual([expect.objectContaining({ character: "C1", death: null })]);
  });

  it("참가자가 아닌(사망자 포함) 캐릭터의 상태 제안은 장면 실패", () => {
    const bad = json({ conditions: [{ character: "C3", thermal: null, pain: null, injury: null, treatment: null, death: null, eventRef: null }] });
    expect(() => parseSceneOutput(bad, ["C1", "C2"], 6)).toThrow(SceneValidationError);
  });
});
