import { describe, expect, it } from "vitest";
import { AVATAR_EXPRESSIONS } from "../../config/avatars";
import { avatarIdsFor, avatarSrc, isAvatarForGender, moodExpression, pickAvailableAvatar } from "@/lib/avatars";
import { characterInputSchema } from "@/lib/schemas/character";
import type { SnapshotV1 } from "@/lib/snapshot/v1";
import { randomizeCharacter } from "@/server/domain/characters/random";
import { parseSnapshot, snapshotChecksum } from "@/server/domain/saves/snapshot";

// 캐릭터 프로필 일러스트: 감정 → 표정 매핑, 성별 목록, 사용 가능 선택, 입력 검증, 랜덤·잠금, 스냅샷 v5 호환·중복 거부

describe("감정 12종 → 표정 8종", () => {
  it("문서 표와 같고, 감정 없음·모르는 값은 neutral", () => {
    const table: Record<string, string> = {
      NEUTRAL: "neutral",
      CALM: "neutral",
      HAPPY: "happy",
      EXCITED: "happy",
      HOPEFUL: "hopeful",
      SAD: "sad",
      LONELY: "sad",
      ANXIOUS: "anxious",
      FEARFUL: "anxious",
      ANGRY: "angry",
      EMBARRASSED: "embarrassed",
      TIRED: "tired",
    };
    for (const [mood, expr] of Object.entries(table)) expect(moodExpression(mood)).toBe(expr);
    expect(new Set(Object.values(table))).toEqual(new Set(AVATAR_EXPRESSIONS));
    expect([moodExpression(null), moodExpression(undefined), moodExpression("UNKNOWN")]).toEqual(["neutral", "neutral", "neutral"]);
    expect(avatarSrc("female-03", "sad")).toBe("/characters/female-03/sad.webp");
    expect(avatarSrc(null)).toBeNull();
    expect(avatarSrc("../etc")).toBeNull();
  });
});

describe("성별 목록과 선택", () => {
  it("여자 17종·남자 6종, 그 밖의 성별은 빈 목록. 사용 중인 ID는 고르지 않고 소진되면 null", () => {
    expect(avatarIdsFor("FEMALE")).toHaveLength(17);
    expect(avatarIdsFor("MALE")).toEqual(["male-01", "male-02", "male-03", "male-04", "male-05", "male-06"]);
    expect(avatarIdsFor("NONBINARY")).toEqual([]);
    expect(isAvatarForGender("male-01", "FEMALE")).toBe(false);
    expect(pickAvailableAvatar("MALE", ["male-01", "male-02"], () => 0)).toBe("male-03");
    expect(pickAvailableAvatar("MALE", avatarIdsFor("MALE"))).toBeNull();
  });

  it("입력 검증: 필수, 알려진 ID, 성별 일치", () => {
    const base = {
      name: "도윤",
      gender: "MALE",
      age: 30,
      personalityTags: ["calm", "honest", "diligent"],
      characterContext: "",
      childhoodBackgroundId: "childhood_city",
      adulthoodBackgroundId: "adulthood_doctor",
    };
    expect(characterInputSchema.safeParse({ ...base, avatarId: "male-02" }).success).toBe(true);
    for (const avatarId of [undefined, "male-99", "female-01"]) expect(characterInputSchema.safeParse({ ...base, avatarId }).success).toBe(false);
  });
});

describe("랜덤·잠금", () => {
  const draft = { name: "", gender: null, age: null, personalityTags: [], characterContext: "", childhoodBackgroundId: null, adulthoodBackgroundId: null, avatarId: null };

  it("전체 랜덤은 성별에 맞고 사용 중이 아닌 일러스트를 고른다. 잠근 일러스트는 유지한다", () => {
    for (let i = 0; i < 20; i++) {
      const next = randomizeCharacter(draft, { usedAvatarIds: ["female-01", "male-01"] });
      expect(isAvatarForGender(next.avatarId, next.gender)).toBe(true);
      expect(["female-01", "male-01"]).not.toContain(next.avatarId);
    }
    const locked = randomizeCharacter({ ...draft, gender: "FEMALE", avatarId: "female-07" }, { lockedFields: ["gender", "avatarId"] });
    expect(locked.avatarId).toBe("female-07");
  });

  it("성별 규칙이 잠금보다 우선: 성별이 바뀌어 맞지 않거나 사용 중이 된 잠긴 일러스트는 다시 고르고, 남은 것이 없으면 null", () => {
    const switched = randomizeCharacter({ ...draft, gender: "FEMALE", avatarId: "female-07" }, { fields: ["gender"], lockedFields: ["avatarId"] }, () => 0); // 성별 목록 [남, 여]
    expect(switched.gender).toBe("MALE");
    expect(switched.avatarId).toMatch(/^male-/);
    const taken = randomizeCharacter({ ...draft, gender: "MALE", avatarId: "male-01" }, { fields: ["name"], lockedFields: ["avatarId"], usedAvatarIds: ["male-01"] }, () => 0);
    expect(taken.avatarId).toBe("male-02");
    const none = randomizeCharacter({ ...draft, gender: "MALE" }, { fields: ["avatarId"], usedAvatarIds: avatarIdsFor("MALE") });
    expect(none.avatarId).toBeNull();
  });
});

describe("스냅샷 v5·v6", () => {
  const t = "2026-10-28T00:00:00.000Z";
  const character = (id: string, gender: "FEMALE" | "MALE") => ({
    id,
    name: id,
    gender,
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
    deletedAt: null as string | null,
    createdAt: t,
  });
  const v1: SnapshotV1 = {
    schemaVersion: 1,
    capturedAt: t,
    world: { name: "w", summary: null, eraAndPlace: null, worldRules: null, currentSituation: null, worldContext: "" },
    gameState: { nextSceneSeq: 1, strategyMode: "STORY", intervalPreset: "NORMAL", maxTurnsPerScene: 6, participantsMin: 2, participantsMax: 3, modelOverride: null, lastCommittedAt: null },
    characters: [character("a", "FEMALE"), character("b", "FEMALE"), character("c", "MALE")],
    relationshipBaselines: [],
    relationshipStates: [],
    relationshipChanges: [],
    emotionStates: [],
    emotionChanges: [],
    memories: [],
    scenes: [],
    worldEvents: [],
  };
  const parse = (version: number, payload: unknown) => parseSnapshot({ schemaVersion: version, payload, checksum: snapshotChecksum(payload).checksum });

  it("이전 버전(v1·v4)은 checksum 그대로 읽혀 avatarId NULL(임의 배정 없음)", () => {
    const latest = parse(1, v1);
    expect(latest.schemaVersion).toBe(6);
    expect(latest.characters.map((c) => c.avatarId)).toEqual([null, null, null]);
    // v4 원본(목표 포함, 일러스트 없음)
    const v4 = { ...latest, schemaVersion: 4, characters: latest.characters.map(({ avatarId, ...c }) => (void avatarId, { ...c, goal: null })) };
    expect(parse(4, v4).characters.map((c) => c.avatarId)).toEqual([null, null, null]);
  });

  it("v5 원본(목표 포함)은 목표를 버리고 v6으로 읽는다. 활성 캐릭터끼리 중복·성별 불일치는 거절, 삭제된 캐릭터와의 중복은 허용", () => {
    const latest = parse(1, v1);
    const v5 = (ids: (string | null)[], deleted: number[] = []) => ({
      ...latest,
      schemaVersion: 5,
      characters: latest.characters.map((c, i) => ({ ...c, goal: "옛 목표", avatarId: ids[i] ?? null, deletedAt: deleted.includes(i) ? t : null })),
    });
    const read = parse(5, v5(["female-01", "female-02", "male-01"]));
    expect(read.schemaVersion).toBe(6);
    expect(read.characters.map((c) => c.avatarId)).toEqual(["female-01", "female-02", "male-01"]);
    expect(read.characters.every((c) => !("goal" in c))).toBe(true);
    expect(() => parse(5, v5(["female-01", "female-01", null]))).toThrow(expect.objectContaining({ reason: "DUPLICATE_AVATAR" }));
    expect(() => parse(5, v5(["female-01", null, "female-02"]))).toThrow(expect.objectContaining({ reason: "BAD_AVATAR" }));
    expect(parse(5, v5(["female-01", "female-01", null], [1])).characters[1]!.avatarId).toBe("female-01");
    // v6 원본(목표 없음)도 같은 규칙
    const v6 = { ...read, characters: read.characters.map((c, i) => ({ ...c, avatarId: i < 2 ? "female-01" : c.avatarId })) };
    expect(() => parse(6, v6)).toThrow(expect.objectContaining({ reason: "DUPLICATE_AVATAR" }));
    expect(() => parse(6, { ...read, characters: read.characters.map((c) => ({ ...c, goal: null })) })).not.toThrow(); // 모르는 키는 버린다
  });
});
