import { describe, expect, it } from "vitest";
import {
  ADULTHOOD_BACKGROUND_IDS,
  BACKGROUND_PRESETS,
  backgroundsOf,
  CHILDHOOD_BACKGROUND_IDS,
  findBackground,
  pickRandomBackground,
} from "../../config/character-backgrounds";
import { SNAPSHOT_SCHEMA_VERSION } from "../../config/limits";
import { adulthoodBackgroundIssue, characterInputSchema } from "@/lib/schemas/character";
import type { SnapshotV1 } from "@/lib/snapshot/v1";
import { parseSnapshot, snapshotChecksum } from "@/server/domain/saves/snapshot";
import { randomizeCharacter } from "@/server/domain/characters/random";
import { buildStoryPrompt, type PromptCharacter } from "@/server/engine/context/story-prompt";

// 캐릭터 배경 (Phase 7-1): 프리셋 44종, 18/19세 경계, 입력 검증, 가중 랜덤·잠금, 프롬프트, v1 스냅샷 호환

/** 정해진 값을 차례로 돌려주는 rng (소진되면 0) */
const seq = (...values: number[]) => () => values.shift() ?? 0;

describe("프리셋", () => {
  it("유년기 20(일반 8·특수 8·희귀 4), 성년기 24(일반 10·특수 9·희귀 5), ID 중복 없음", () => {
    expect(BACKGROUND_PRESETS).toHaveLength(44);
    const count = (stage: "CHILDHOOD" | "ADULTHOOD") => ["COMMON", "UNCOMMON", "RARE"].map((r) => backgroundsOf(stage, r as "COMMON").length);
    expect(count("CHILDHOOD")).toEqual([8, 8, 4]);
    expect(count("ADULTHOOD")).toEqual([10, 9, 5]);
    expect(new Set(BACKGROUND_PRESETS.map((p) => p.id)).size).toBe(44);
    expect(CHILDHOOD_BACKGROUND_IDS.every((id) => id.startsWith("childhood_"))).toBe(true);
    expect(ADULTHOOD_BACKGROUND_IDS.every((id) => id.startsWith("adulthood_"))).toBe(true);
    expect(findBackground("childhood_clone")).toMatchObject({ name: "복제 인간 프로젝트 출신", rarity: "RARE", stage: "CHILDHOOD" });
    expect(findBackground("adulthood_con_artist")).toMatchObject({ name: "전설적인 사기꾼", description: "뛰어난 언변과 속임수로 사람들을 현혹했다.", rarity: "UNCOMMON" });
    expect(findBackground("adulthood_farmer", "CHILDHOOD")).toBeNull(); // 단계가 다르면 없음
  });

  it("랜덤: 등급 가중(60/30/10) 뒤 등급 안 균등", () => {
    expect(pickRandomBackground("CHILDHOOD", seq(0.59, 0)).id).toBe("childhood_farm");
    expect(pickRandomBackground("CHILDHOOD", seq(0.6, 0)).rarity).toBe("UNCOMMON");
    expect(pickRandomBackground("CHILDHOOD", seq(0.899, 0.999)).id).toBe("childhood_gang_errand");
    expect(pickRandomBackground("ADULTHOOD", seq(0.9, 0.999)).id).toBe("adulthood_dimension_explorer");
    // 대략적인 분포 (결정적 rng)
    let x = 1;
    const lcg = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const tally = { COMMON: 0, UNCOMMON: 0, RARE: 0 };
    for (let i = 0; i < 10_000; i++) tally[pickRandomBackground("ADULTHOOD", lcg).rarity]++;
    expect(tally.COMMON / 10_000).toBeCloseTo(0.6, 1);
    expect(tally.UNCOMMON / 10_000).toBeCloseTo(0.3, 1);
    expect(tally.RARE / 10_000).toBeCloseTo(0.1, 1);
  });
});

describe("입력 검증", () => {
  const input = (patch: Record<string, unknown>) =>
    characterInputSchema.safeParse({ name: "a", gender: "MALE", age: 30, personalityTags: ["sociable", "calm", "diligent"], characterContext: "", childhoodBackgroundId: "childhood_city", adulthoodBackgroundId: "adulthood_doctor", avatarId: "male-01", ...patch });

  it("유년기 필수·알 수 없는 ID·단계가 다른 ID는 거절", () => {
    expect(input({}).success).toBe(true);
    expect(input({ childhoodBackgroundId: undefined }).success).toBe(false);
    expect(input({ childhoodBackgroundId: null }).success).toBe(false);
    expect(input({ childhoodBackgroundId: "childhood_custom_text" }).success).toBe(false);
    expect(input({ childhoodBackgroundId: "adulthood_doctor" }).success).toBe(false);
    expect(input({ adulthoodBackgroundId: "childhood_city" }).success).toBe(false);
  });

  it("18/19세 경계: 19세 이상은 성년기 필수, 18세 이하는 불가. 나이를 비우면 서버가 확정 나이로 다시 검사", () => {
    expect(input({ age: 19, adulthoodBackgroundId: null }).success).toBe(false);
    expect(input({ age: 19 }).success).toBe(true);
    expect(input({ age: 18 }).success).toBe(false);
    expect(input({ age: 18, adulthoodBackgroundId: null }).success).toBe(true);
    expect(input({ age: null, adulthoodBackgroundId: null }).success).toBe(true);
    expect(adulthoodBackgroundIssue(19, null)).toContain("성년기 배경을 선택");
    expect(adulthoodBackgroundIssue(18, "adulthood_doctor")).toContain("설정할 수 없습니다");
    expect(adulthoodBackgroundIssue(0, null)).toBeNull();
  });
});

describe("랜덤 생성", () => {
  const draft = { name: "", gender: null, age: null, personalityTags: [], characterContext: "", childhoodBackgroundId: null, adulthoodBackgroundId: null, avatarId: null };

  it("전체 랜덤은 유년기를 항상, 성인이면 성년기도 고른다", () => {
    const next = randomizeCharacter(draft, {}, () => 0.5);
    expect(findBackground(next.childhoodBackgroundId, "CHILDHOOD")).not.toBeNull();
    expect(next.age).toBeGreaterThanOrEqual(19);
    expect(findBackground(next.adulthoodBackgroundId, "ADULTHOOD")).not.toBeNull();
    const minor = randomizeCharacter({ ...draft, adulthoodBackgroundId: "adulthood_doctor" }, { fields: ["age"] }, () => 0.1); // 랜덤 나이 1~80: 9세
    expect(minor).toMatchObject({ age: 9, adulthoodBackgroundId: null });
  });

  it("나이 규칙이 잠금보다 우선: 잠근 나이가 18세 이하면 잠근 성년기도 비운다. 항목별 랜덤은 다른 배경을 건드리지 않는다", () => {
    const minor = randomizeCharacter({ ...draft, age: 12, adulthoodBackgroundId: "adulthood_doctor" }, { lockedFields: ["age", "adulthoodBackgroundId"] }, () => 0.5);
    expect(minor).toMatchObject({ age: 12, adulthoodBackgroundId: null });
    expect(minor.childhoodBackgroundId).not.toBeNull();
    const onlyChildhood = randomizeCharacter({ ...draft, age: 30, adulthoodBackgroundId: "adulthood_chef" }, { fields: ["childhoodBackgroundId"] }, () => 0.95);
    expect(onlyChildhood.adulthoodBackgroundId).toBe("adulthood_chef");
    expect(findBackground(onlyChildhood.childhoodBackgroundId)?.rarity).toBe("RARE");
    const locked = randomizeCharacter({ ...draft, age: 30, childhoodBackgroundId: "childhood_pirate" }, { lockedFields: ["childhoodBackgroundId"] }, () => 0.1);
    expect(locked.childhoodBackgroundId).toBe("childhood_pirate");
  });
});

describe("프롬프트", () => {
  it("배경 이름·설명을 과거 경험으로 넣고, 현재 행동을 강제하지 않도록 지시한다", () => {
    const c: PromptCharacter = {
      alias: "C1",
      name: "가람",
      gender: "FEMALE",
      genderCustom: null,
      age: 30,
      personalityTags: [],
      bigFive: { extraversion: 50, agreeableness: 50, conscientiousness: 50, emotionalStability: 50, openness: 50 },
      characterContext: "",
      mood: null,
      moodIntensity: null,
      backgrounds: [
        { stage: "유년기", name: "어촌의 아이", description: "바다와 배에 익숙한 환경에서 성장했다." },
        { stage: "성년기", name: "요리사", description: "다양한 식재료를 다루고 음식을 만들었다." },
      ],
    };
    const { prompt, systemInstruction } = buildStoryPrompt({ name: "w", worldRules: null, currentSituation: null, worldContext: "" }, [c, { ...c, alias: "C2", backgrounds: [] }], 6);
    expect(prompt).toContain("과거 배경: 유년기 — 어촌의 아이(바다와 배에 익숙한 환경에서 성장했다.) / 성년기 — 요리사(다양한 식재료를 다루고 음식을 만들었다.)");
    expect(prompt.match(/과거 배경:/g)).toHaveLength(1);
    expect(systemInstruction).toContain("과거의 일을 지금 일어나는 사건처럼 쓰지 않는다");
  });
});

describe("세이브 호환", () => {
  const t = "2026-10-28T00:00:00.000Z";
  const v1: SnapshotV1 = {
    schemaVersion: 1,
    capturedAt: t,
    world: { name: "w", summary: null, eraAndPlace: null, worldRules: null, currentSituation: null, worldContext: "" },
    gameState: { nextSceneSeq: 1, strategyMode: "STORY", intervalPreset: "NORMAL", maxTurnsPerScene: 6, participantsMin: 2, participantsMax: 3, modelOverride: null, lastCommittedAt: null },
    characters: [
      {
        id: "a",
        name: "a",
        gender: "UNSPECIFIED",
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
        initialMood: "NEUTRAL",
        initialMoodIntensity: 50,
        sortOrder: 0,
        deletedAt: null,
        createdAt: t,
      },
    ],
    relationshipBaselines: [],
    relationshipStates: [],
    relationshipChanges: [],
    emotionStates: [],
    emotionChanges: [],
    memories: [],
    scenes: [],
    worldEvents: [],
  };

  it("v1 스냅샷은 저장된 checksum 그대로 읽히고 배경 NULL인 최신 버전이 된다. v2의 잘못된 배경은 거절", () => {
    const parsed = parseSnapshot({ schemaVersion: 1, payload: v1, checksum: snapshotChecksum(v1).checksum });
    expect(parsed.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(parsed.characters[0]).toMatchObject({ id: "a", childhoodBackgroundId: null, adulthoodBackgroundId: null });

    const v2 = { ...v1, schemaVersion: 2, characters: [{ ...v1.characters[0]!, childhoodBackgroundId: "childhood_city", adulthoodBackgroundId: "adulthood_doctor" }] };
    expect(parseSnapshot({ schemaVersion: 2, payload: v2, checksum: snapshotChecksum(v2).checksum }).characters[0]!.adulthoodBackgroundId).toBe("adulthood_doctor");
    const minor = { ...v2, characters: [{ ...v2.characters[0]!, age: 10 }] };
    expect(() => parseSnapshot({ schemaVersion: 2, payload: minor, checksum: snapshotChecksum(minor).checksum })).toThrow(expect.objectContaining({ code: "SAVE_INVALID" }));
    const unknown = { ...v2, characters: [{ ...v2.characters[0]!, childhoodBackgroundId: "childhood_custom" }] };
    expect(() => parseSnapshot({ schemaVersion: 2, payload: unknown, checksum: snapshotChecksum(unknown).checksum })).toThrow(expect.objectContaining({ code: "SAVE_INVALID" }));
  });
});
