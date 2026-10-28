import { describe, expect, it } from "vitest";
import { snapshotReferenceError, snapshotV1Schema, type SnapshotV1 } from "@/lib/snapshot/v1";
import { canonicalJson, snapshotChecksum } from "@/server/domain/saves/snapshot";

// 스냅샷 v1 구조·참조 검증과 checksum (Phase 6)
const t = "2026-10-28T00:00:00.000Z";
const character = (id: string, deletedAt: string | null = null) => ({
  id,
  name: id,
  gender: "UNSPECIFIED" as const,
  genderCustom: null,
  age: 20,
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
  deletedAt,
  createdAt: t,
});
const base: SnapshotV1 = {
  schemaVersion: 1,
  capturedAt: t,
  world: { name: "w", summary: null, eraAndPlace: null, worldRules: null, currentSituation: null, worldContext: "" },
  gameState: { nextSceneSeq: 1, strategyMode: "STORY", intervalPreset: "NORMAL", maxTurnsPerScene: 6, participantsMin: 2, participantsMax: 3, modelOverride: null, lastCommittedAt: null },
  characters: [character("a"), character("b")],
  relationshipBaselines: [],
  relationshipStates: [],
  relationshipChanges: [],
  emotionStates: [],
  emotionChanges: [],
  memories: [],
  scenes: [],
  worldEvents: [],
};
const memory = (owner: string, about: string | null) => ({
  id: "m",
  ownerCharacterId: owner,
  aboutCharacterId: about,
  kind: "EVENT" as const,
  acquisition: "WITNESSED" as const,
  content: "x",
  importance: 3,
  sourceSceneId: null,
  shareGroupId: null,
  createdAt: t,
});

describe("스냅샷 v1", () => {
  it("구조 검증: 버전·enum·필드", () => {
    expect(snapshotV1Schema.safeParse(base).success).toBe(true);
    expect(snapshotV1Schema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
    expect(snapshotV1Schema.safeParse({ ...base, characters: [{ ...character("a"), gender: "X" }] }).success).toBe(false);
  });

  it("참조 검증: 없는 캐릭터·자기 관계·활성 7명·장면 번호", () => {
    expect(snapshotReferenceError(base)).toBeNull();
    expect(snapshotReferenceError({ ...base, memories: [memory("a", "zzz")] })).toBe("BAD_MEMORY_REF");
    expect(snapshotReferenceError({ ...base, relationshipStates: [{ id: "r", fromCharacterId: "a", toCharacterId: "a", affinity: 0, trust: 0, respect: 0, familiarity: 0 }] })).toBe(
      "BAD_RELATIONSHIP_REF",
    );
    const seven = Array.from({ length: 7 }, (_, i) => character(`c${i}`));
    expect(snapshotReferenceError({ ...base, characters: seven })).toBe("TOO_MANY_CHARACTERS");
    expect(snapshotReferenceError({ ...base, characters: [...seven.slice(0, 6), character("gone", t)] })).toBeNull(); // 삭제된 캐릭터는 세지 않는다
  });

  it("checksum은 키 순서와 무관하다 (jsonb 저장 후에도 같은 값)", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}');
    expect(snapshotChecksum({ b: 1, a: 2 }).checksum).toBe(snapshotChecksum({ a: 2, b: 1 }).checksum);
  });
});
