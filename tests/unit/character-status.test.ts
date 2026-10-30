import { describe, expect, it } from "vitest";
import { abnormalConditions, injuryBar, intensityBar, moodVisual, painBar, relationBar, thermalBar } from "@/lib/character-status";

// 캐릭터 상세 게임형 상태창: 저장 값 → 표시 단계 변환 (UI 전용, 저장 값은 바꾸지 않는다)

const rel = (affinity: number, trust: number, respect: number, familiarity = 0) => ({ affinity, trust, respect, familiarity });

describe("관계 5단계", () => {
  it("호감·신뢰·존중 평균으로 판정하고 친밀도는 좋고 나쁨에 넣지 않는다", () => {
    expect(relationBar(rel(0, 0, 0)).text).toBe("보통"); // 초기값
    expect(relationBar(rel(0, 0, 0, 100)).text).toBe("보통");
    expect([rel(-100, -100, -100), rel(-60, -60, -60), rel(-59, -60, -60), rel(-20, -20, -20), rel(-19, -20, -20), rel(19, 20, 20), rel(20, 20, 20), rel(59, 60, 60), rel(60, 60, 60), rel(100, 100, 100)].map((r) => relationBar(r).text)).toEqual([
      "매우 나쁨",
      "매우 나쁨",
      "나쁨",
      "나쁨",
      "보통",
      "보통",
      "좋음",
      "좋음",
      "매우 좋음",
      "매우 좋음",
    ]);
    expect(relationBar(rel(100, 100, 100))).toMatchObject({ segments: 5, filled: 5 });
    expect(relationBar(rel(-100, -100, -100))).toMatchObject({ segments: 5, filled: 1 });
  });

  it("방향별 값이 다르면 단계도 따로 나온다 (A→B 좋음, B→A 나쁨)", () => {
    const outgoing = rel(40, 30, 20);
    const incoming = rel(-40, -30, -20);
    expect(relationBar(outgoing).text).toBe("좋음");
    expect(relationBar(incoming).text).toBe("나쁨");
  });
});

describe("감정 강도 5단계", () => {
  it("0~20 매우 약함 … 81~100 매우 강함, 범위 밖은 잘라서 본다", () => {
    expect([0, 20, 21, 40, 41, 60, 61, 80, 81, 100, 130, -5].map((v) => intensityBar("ANXIOUS", v).text)).toEqual([
      "매우 약함",
      "매우 약함",
      "약함",
      "약함",
      "보통",
      "보통",
      "강함",
      "강함",
      "매우 강함",
      "매우 강함",
      "매우 강함",
      "매우 약함",
    ]);
    expect(intensityBar("ANXIOUS", 100)).toMatchObject({ segments: 5, filled: 5, color: moodVisual("ANXIOUS").color });
    expect(moodVisual("UNKNOWN")).toEqual(moodVisual("NEUTRAL"));
  });
});

describe("신체 상태 막대", () => {
  it("정상은 빈 막대, 기존 단계만큼 칸을 채운다", () => {
    expect(thermalBar("NONE", "NONE")).toMatchObject({ filled: 0, text: "정상" });
    expect(thermalBar("COLD", "MILD")).toMatchObject({ segments: 3, filled: 1, text: "경미", label: "추위", cause: "COLD" });
    expect(thermalBar("HEAT", "EXTREME")).toMatchObject({ segments: 3, filled: 3, text: "극심", label: "더위", cause: "HEAT" });
    expect(thermalBar("COLD", "SEVERE").color).not.toBe(thermalBar("HEAT", "SEVERE").color); // 추위·더위 구분
    expect(painBar("NONE")).toMatchObject({ filled: 0, text: "없음" });
    expect(painBar("SEVERE")).toMatchObject({ segments: 3, filled: 2, text: "심함" });
    expect(injuryBar("NONE")).toMatchObject({ filled: 0, text: "없음" });
    expect(injuryBar("MILD")).toMatchObject({ segments: 4, filled: 1, text: "약간 아픔" });
    expect(injuryBar("CRITICAL")).toMatchObject({ segments: 4, filled: 4, text: "위독" });
    expect(injuryBar("MILD").color).not.toBe(injuryBar("CRITICAL").color);
  });
});

describe("현재 상태 카드: 정상이 아닌 신체 항목만", () => {
  const normal = { thermalCause: "NONE", thermalLevel: "NONE", painLevel: "NONE", painCause: null, injury: "NONE", injuryCause: null } as const;
  const keys = (c: Parameters<typeof abnormalConditions>[0]) => abnormalConditions(c).map((a) => `${a.label}:${a.bar.text}`);

  it("모두 정상이면 비고, 이상 항목만 순서대로(추위·더위 → 고통 → 부상) 나온다", () => {
    expect(abnormalConditions(normal)).toEqual([]);
    expect(keys({ ...normal, thermalCause: "COLD", thermalLevel: "SEVERE" })).toEqual(["추위:심함"]);
    expect(keys({ ...normal, thermalCause: "HEAT", thermalLevel: "MILD" })).toEqual(["더위:경미"]);
    expect(keys({ ...normal, painLevel: "EXTREME", painCause: "화상" })).toEqual(["고통:극심"]);
    expect(abnormalConditions({ ...normal, injury: "MODERATE", injuryCause: "넘어짐" })).toEqual([
      { key: "injury", label: "부상", bar: injuryBar("MODERATE"), detail: "넘어짐" },
    ]);
    expect(keys({ thermalCause: "HEAT", thermalLevel: "EXTREME", painLevel: "MILD", painCause: null, injury: "CRITICAL", injuryCause: null })).toEqual([
      "더위:극심",
      "고통:경미",
      "부상:위독",
    ]);
  });
});
