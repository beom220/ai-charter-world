import { describe, expect, it } from "vitest";
import { EMPTY_CHARACTER_DRAFT, speakerHref, togglePersonalityTag } from "@/lib/character-form";
import { characterInputSchema } from "@/lib/schemas/character";
import { autoAge, randomAge, randomGender } from "@/server/domain/characters/random";

// 캐릭터 화면 개선: 성격 다중 선택 제한, 빈 생성 폼, 대화 속 이름 링크, 성별(남자·여자), 랜덤 나이 1~80·자동 나이 19~80

describe("캐릭터 화면", () => {
  it("성격 토글: 추가·제거, 5개가 차면 더 넣지 않는다", () => {
    expect(togglePersonalityTag(["calm"], "kind")).toEqual(["calm", "kind"]);
    expect(togglePersonalityTag(["calm", "kind"], "calm")).toEqual(["kind"]);
    const five = ["a", "b", "c", "d", "e"];
    expect(togglePersonalityTag(five, "f")).toEqual(five);
    expect(togglePersonalityTag(five, "c")).toEqual(["a", "b", "d", "e"]);
  });

  it("새 캐릭터 폼은 모든 값이 빈 상태로 시작한다", () => {
    expect(EMPTY_CHARACTER_DRAFT).toEqual({
      name: "",
      gender: null,
      age: null,
      personalityTags: [],
      goal: "",
      characterContext: "",
      childhoodBackgroundId: null,
      adulthoodBackgroundId: null,
    });
  });

  it("발화자 링크는 이 세계관의 활성 캐릭터 ID로만 만든다 (같은 이름도 ID로 구분, 삭제된 캐릭터는 링크 없음)", () => {
    const active = new Set(["c1", "c2"]);
    expect(speakerHref("w1", "c2", active)).toBe("/worlds/w1/characters/c2");
    expect(speakerHref("w1", "c1", active)).toBe("/worlds/w1/characters/c1");
    expect(speakerHref("w1", "deleted", active)).toBeNull();
    expect(speakerHref("w1", null, active)).toBeNull();
  });

  it("성별은 남자·여자만 받고, 랜덤 성별·나이도 같은 범위다", () => {
    const base = { name: "a", age: 30, personalityTags: ["sociable", "calm", "diligent"], characterContext: "", childhoodBackgroundId: "childhood_city", adulthoodBackgroundId: "adulthood_doctor" };
    expect(characterInputSchema.safeParse({ ...base, gender: "MALE" }).success).toBe(true);
    expect(characterInputSchema.safeParse({ ...base, gender: "FEMALE" }).success).toBe(true);
    for (const gender of ["AUTO", "NONBINARY", "CUSTOM", "UNSPECIFIED", undefined]) expect(characterInputSchema.safeParse({ ...base, gender }).success).toBe(false);
    expect(characterInputSchema.safeParse({ ...base, gender: "MALE", age: 1001 }).success).toBe(false);
    expect(new Set([0, 0.49, 0.5, 0.99].map((r) => randomGender(() => r)))).toEqual(new Set(["MALE", "FEMALE"]));
    expect(randomAge(() => 0)).toBe(1);
    expect(randomAge(() => 0.999999)).toBe(80);
    expect(autoAge(() => 0)).toBe(19); // 빈 나이 자동 설정은 성년기 배경과 충돌하지 않게 성인만
    expect(autoAge(() => 0.999999)).toBe(80);
  });
});
