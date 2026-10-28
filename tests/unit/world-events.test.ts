import { describe, expect, it } from "vitest";
import { AUTO_EVENT_CHANCE } from "../../config/limits";
import { EVENT_PRESETS, findEventPreset } from "../../config/world-events";
import type { SnapshotV1 } from "@/lib/snapshot/v1";
import { migrateV1ToV2 } from "@/lib/snapshot/v2";
import { migrateV2ToV3, type SnapshotV3 } from "@/lib/snapshot/v3";
import { parseSnapshot, snapshotChecksum } from "@/server/domain/saves/snapshot";
import { autoEventPeriodOf, pickAutoEventPreset, rollAutoEventPeriod } from "@/server/engine/director/auto-events";

// Phase 7-2-1: 자동 사건 프리셋 24종, 20장면 구간 추첨, 프리셋 반복 방지, 스냅샷 v1·v2·v3 → 최신(v4) 호환과 v3 불변식.
// (부상 회복 규칙은 7-2-2에서 월드 시간 기준으로 바뀌어 world-time-conditions.test.ts에서 본다)

const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++]!;
};

describe("자동 사건 프리셋", () => {
  it("명세의 24개 ID·범주·강도를 정확히 등록하고, 생물 대체 프리셋은 생물이 아니다", () => {
    expect(EVENT_PRESETS).toHaveLength(24);
    expect(new Set(EVENT_PRESETS.map((p) => p.id)).size).toBe(24);
    const count = (c: string) => EVENT_PRESETS.filter((p) => p.category === c).length;
    expect([count("CREATURE"), count("ENVIRONMENT"), count("HEALTH"), count("SURVIVAL"), count("DISCOVERY"), count("SOCIAL"), count("DILEMMA")]).toEqual([5, 4, 3, 4, 3, 3, 2]);
    expect(EVENT_PRESETS.map((p) => `${p.id}:${p.intensity}`)).toEqual([
      "creature_predator_appears:HIGH",
      "creature_attack:HIGH",
      "creature_unknown:MEDIUM",
      "creature_territory:MEDIUM",
      "creature_migration:MEDIUM",
      "environment_extreme_weather:HIGH",
      "environment_disaster:HIGH",
      "environment_contamination:MEDIUM",
      "environment_blocked_route:MEDIUM",
      "health_injury:MEDIUM",
      "health_illness:MEDIUM",
      "health_work_accident:HIGH",
      "survival_food_shortage:MEDIUM",
      "survival_water_crisis:HIGH",
      "survival_equipment_failure:MEDIUM",
      "survival_supplies_missing:MEDIUM",
      "discovery_traces:LOW",
      "discovery_location:LOW",
      "discovery_object:LOW",
      "social_visitor:MEDIUM",
      "social_rumor:LOW",
      "social_conflict:MEDIUM",
      "dilemma_risky_choice:HIGH",
      "dilemma_resource_allocation:MEDIUM",
    ]);
    for (const p of EVENT_PRESETS.filter((x) => x.category === "CREATURE")) expect(findEventPreset(p.fallbackId)?.category).not.toBe("CREATURE");
    for (const p of EVENT_PRESETS.filter((x) => x.category !== "CREATURE")) expect(p.fallbackId).toBeNull();
  });
});

describe("20장면 구간 추첨", () => {
  it("구간은 #3~#22, #23~#42 … 이고 #1·#2는 판정하지 않는다", () => {
    expect(autoEventPeriodOf(1)).toBeNull();
    expect(autoEventPeriodOf(2)).toBeNull();
    expect(autoEventPeriodOf(3)).toEqual({ index: 0, startSeq: 3, endSeq: 22 });
    expect(autoEventPeriodOf(22)).toEqual({ index: 0, startSeq: 3, endSeq: 22 });
    expect(autoEventPeriodOf(23)).toEqual({ index: 1, startSeq: 23, endSeq: 42 });
    expect(autoEventPeriodOf(43)?.index).toBe(2);
  });

  it("구간당 한 번 40%: 당첨이면 구간 안 장면 하나를 예약하고, 구간 중간 첫 판정은 지난 장면에 예약하지 않는다", () => {
    const p = autoEventPeriodOf(3)!;
    expect(rollAutoEventPeriod(p, seq(AUTO_EVENT_CHANCE))).toEqual({ won: false, scheduledSceneSeq: null });
    expect(rollAutoEventPeriod(p, seq(0.39, 0))).toEqual({ won: true, scheduledSceneSeq: 3 });
    expect(rollAutoEventPeriod(p, seq(0, 0.9999))).toEqual({ won: true, scheduledSceneSeq: 22 });
    expect(rollAutoEventPeriod(p, seq(0, 0), 15)).toEqual({ won: true, scheduledSceneSeq: 15 });
    expect(rollAutoEventPeriod(p, seq(0, 0.9999), 15).scheduledSceneSeq).toBe(22);
  });

  it("프리셋: 최근 8개 ID와 직전 범주를 빼고, 후보가 없으면 단계적으로 완화한다", () => {
    const recent = EVENT_PRESETS.slice(0, 8).map((p) => ({ presetId: p.id, category: p.category }));
    for (const r of [0, 0.5, 0.9999]) {
      const picked = findEventPreset(pickAutoEventPreset(recent, () => r))!;
      expect(recent.map((x) => x.presetId)).not.toContain(picked.id);
      expect(picked.category).not.toBe(recent[0]!.category);
    }
    // 모든 프리셋이 최근 목록에 있으면(8개 제한을 넘는 입력) 범주·ID 제외를 풀어 직전 ID만 피한다
    const all = EVENT_PRESETS.map((p) => ({ presetId: p.id, category: p.category }));
    expect(pickAutoEventPreset(all, () => 0)).not.toBe(all[0]!.presetId);
    expect(EVENT_PRESETS.map((p) => p.id)).toContain(pickAutoEventPreset([], () => 0.5));
  });
});

describe("스냅샷 v3 호환 (최신 v4로 읽기)", () => {
  const t = "2026-10-28T00:00:00.000Z";
  const character = {
    id: "a",
    name: "a",
    gender: "FEMALE" as const,
    genderCustom: null,
    age: 30,
    personalityTags: [],
    extraversion: 50,
    agreeableness: 50,
    conscientiousness: 50,
    emotionalStability: 50,
    openness: 50,
    goal: null,
    characterContext: "",
    initialMood: "NEUTRAL" as const,
    initialMoodIntensity: 50,
    sortOrder: 0,
    deletedAt: null,
    createdAt: t,
  };
  const scene = {
    id: "s1",
    seq: 1,
    attemptId: "at1",
    runId: null,
    strategyMode: "STORY" as const,
    model: "m",
    title: "t",
    summary: "s",
    motiveType: "MIXED" as const,
    motiveRef: null,
    endReason: "RESOLVED" as const,
    contextTruncated: false,
    createdAt: t,
    participants: [],
    messages: [],
  };
  const v1: SnapshotV1 = {
    schemaVersion: 1,
    capturedAt: t,
    world: { name: "w", summary: null, eraAndPlace: null, worldRules: null, currentSituation: null, worldContext: "" },
    gameState: { nextSceneSeq: 2, strategyMode: "STORY", intervalPreset: "NORMAL", maxTurnsPerScene: 6, participantsMin: 2, participantsMax: 3, modelOverride: null, lastCommittedAt: null },
    characters: [character, { ...character, id: "b", name: "b" }],
    relationshipBaselines: [],
    relationshipStates: [],
    relationshipChanges: [],
    emotionStates: [],
    emotionChanges: [],
    memories: [],
    scenes: [scene],
    worldEvents: [{ id: "e1", kind: "SCENE_OUTCOME", title: "t", description: "d", visibility: "PUBLIC", status: "ACTIVE", sourceSceneId: "s1", createdAt: t, resolvedAt: null }],
  };
  const parse = (version: number, payload: unknown) => parseSnapshot({ schemaVersion: version, payload, checksum: snapshotChecksum(payload).checksum });

  it("v1·v2 원본은 checksum 그대로 읽혀 최신이 된다: 모든 캐릭터 생존·정상·고통 없음·부상 없음, 사건 새 필드 NULL, 구간 기록 없음, 월드 시간 0", () => {
    const v2 = { ...v1, schemaVersion: 2, characters: v1.characters.map((c) => ({ ...c, childhoodBackgroundId: null, adulthoodBackgroundId: null })) };
    for (const [version, payload] of [[1, v1], [2, v2]] as const) {
      const p = parse(version, payload);
      expect(p.schemaVersion).toBe(4);
      expect(p.gameState.worldSeconds).toBe(0);
      expect(p.characterConditions.map((c) => [c.characterId, c.vital, c.injury, c.thermalCause, c.painLevel])).toEqual([
        ["a", "ALIVE", "NONE", "NONE", "NONE"],
        ["b", "ALIVE", "NONE", "NONE", "NONE"],
      ]);
      expect(p.worldEvents[0]).toMatchObject({ id: "e1", status: "ACTIVE", presetId: null, startedSceneSeq: null, requestId: null });
      expect(p.eventPeriods).toEqual([]);
      expect(p.conditionChanges).toEqual([]);
    }
  });

  it("v3 참조·불변식: 사망 기록 누락, 없는 사건을 가리키는 구간, 상태가 없는 캐릭터, 알 수 없는 프리셋, 대기 4건은 거절. v3 상태는 보존적으로 옮긴다", () => {
    const v3 = migrateV2ToV3(migrateV1ToV2(v1));
    const ok: SnapshotV3 = {
      ...v3,
      worldEvents: [...v3.worldEvents, { ...v3.worldEvents[0]!, id: "e2", kind: "RANDOM", presetId: "creature_attack", intensity: "HIGH", startedSceneSeq: 1, lastSceneSeq: 1 }],
      eventPeriods: [{ periodIndex: 0, won: true, scheduledSceneSeq: 3, presetId: "creature_attack", eventId: "e2", firedAt: t, createdAt: t }],
      characterConditions: [
        { ...v3.characterConditions[0]!, injury: "SEVERE", injuryCause: "늑대에게 물림", injurySceneSeq: 1, injuryUpdatedSceneSeq: 1, thermal: "VERY_COLD" },
        { ...v3.characterConditions[1]!, vital: "DEAD", deathCause: "습격", deathSceneSeq: 1, diedAt: t },
      ],
      conditionChanges: [{ id: "cc1", characterId: "b", sceneId: "s1", eventId: "e2", kind: "DEATH", fromValue: "ALIVE", toValue: "DEAD", reason: "습격", createdAt: t }],
    };
    const read = parse(3, ok);
    expect(read.characterConditions[1]).toMatchObject({ vital: "DEAD", deathCause: "습격" });
    // VERY_COLD → 추위·심함, 부상 SEVERE → 고통 심함(원인 유지), 회복 기준은 월드 시각 0부터
    expect(read.characterConditions[0]).toMatchObject({
      thermalCause: "COLD",
      thermalLevel: "SEVERE",
      painLevel: "SEVERE",
      painCause: "늑대에게 물림",
      injury: "SEVERE",
      injuryUpdatedAtSeconds: 0,
      extremeSinceSeconds: null,
    });

    const pending = (i: number) => ({ ...v3.worldEvents[0]!, id: `p${i}`, kind: "USER_INTERVENTION" as const, status: "PENDING" as const, requestId: `r${i}` });
    const bad: SnapshotV3[] = [
      { ...ok, characterConditions: [ok.characterConditions[0]!, { ...ok.characterConditions[1]!, deathCause: null }] },
      { ...ok, eventPeriods: [{ ...ok.eventPeriods[0]!, eventId: "none" }] },
      { ...ok, characterConditions: [ok.characterConditions[0]!] },
      { ...ok, worldEvents: [{ ...ok.worldEvents[1]!, presetId: "creature_dragon" }] },
      { ...ok, worldEvents: [...ok.worldEvents, pending(1), pending(2), pending(3), pending(4)] },
    ];
    for (const p of bad) expect(() => parse(3, p)).toThrow(expect.objectContaining({ code: "SAVE_INVALID" }));
  });
});
