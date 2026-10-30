import { describe, expect, it } from "vitest";
import { abnormalConditions, barFill, injuryBar, intensityBar, painBar, relationBar, thermalBar } from "@/lib/character-status";

// 캐릭터 상세 게임형 상태창: 저장 값 → 양극형 막대 값·문구 (UI 전용, 저장 값은 바꾸지 않는다)

const rel = (affinity: number, trust: number, respect: number, familiarity = 0) => ({ affinity, trust, respect, familiarity });

describe("양극형 막대 채움", () => {
  it("-100 왼쪽 전체, -50 왼쪽 절반, 0 채움 없음, +50 오른쪽 절반, +100 오른쪽 전체 (막대 전체 폭 기준 %)", () => {
    expect([-100, -50, 0, 50, 100].map(barFill)).toEqual([
      { side: "left", widthPercent: 50 },
      { side: "left", widthPercent: 25 },
      { side: null, widthPercent: 0 },
      { side: "right", widthPercent: 25 },
      { side: "right", widthPercent: 50 },
    ]);
    expect(barFill(150)).toEqual({ side: "right", widthPercent: 50 }); // 범위 밖은 자른다
  });
});

describe("관계", () => {
  it("호감·신뢰·존중 평균이 막대 값, 기존 5단계 문구 유지, 친밀도는 넣지 않는다", () => {
    expect(relationBar(rel(0, 0, 0, 100))).toEqual({ value: 0, text: "보통" });
    expect(relationBar(rel(-100, -100, -100))).toEqual({ value: -100, text: "매우 나쁨" });
    expect(relationBar(rel(-50, -50, -50))).toEqual({ value: -50, text: "나쁨" });
    expect(relationBar(rel(50, 50, 50))).toEqual({ value: 50, text: "좋음" });
    expect(relationBar(rel(100, 100, 100))).toEqual({ value: 100, text: "매우 좋음" });
    expect([rel(-60, -60, -60), rel(-59, -60, -60), rel(-19, -20, -20), rel(19, 20, 20), rel(20, 20, 20), rel(59, 60, 60), rel(60, 60, 60)].map((r) => relationBar(r).text)).toEqual([
      "매우 나쁨",
      "나쁨",
      "보통",
      "보통",
      "좋음",
      "좋음",
      "매우 좋음",
    ]);
  });

  it("방향별 값이 다르면 막대도 따로 나온다 (A→B 오른쪽, B→A 왼쪽)", () => {
    expect(relationBar(rel(40, 30, 20)).value).toBe(30);
    expect(relationBar(rel(-40, -30, -20)).value).toBe(-30);
  });
});

describe("감정", () => {
  it("부정 감정은 왼쪽, 긍정 감정은 오른쪽, 평온·차분은 중앙. 길이는 강도, 문구는 강도 단계", () => {
    expect(intensityBar("ANXIOUS", 100)).toEqual({ value: -100, text: "매우 강함" });
    expect(intensityBar("SAD", 50)).toEqual({ value: -50, text: "보통" });
    expect(intensityBar("HAPPY", 50)).toEqual({ value: 50, text: "보통" });
    expect(intensityBar("HOPEFUL", 81)).toEqual({ value: 81, text: "매우 강함" });
    expect(intensityBar("CALM", 70)).toEqual({ value: 0, text: "강함" });
    expect(intensityBar("NEUTRAL", 50).value).toBe(0);
    expect(intensityBar("UNKNOWN", 50).value).toBe(0);
    for (const m of ["ANXIOUS", "SAD", "ANGRY", "FEARFUL", "LONELY", "EMBARRASSED", "TIRED"]) expect(intensityBar(m, 40).value).toBe(-40);
    for (const m of ["HAPPY", "EXCITED", "HOPEFUL"]) expect(intensityBar(m, 40).value).toBe(40);
    expect([0, 20, 21, 40, 41, 60, 61, 80, 81, 100].map((v) => intensityBar("HAPPY", v).text)).toEqual([
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
    ]);
  });
});

describe("신체 상태", () => {
  it("추위는 왼쪽, 더위는 오른쪽, 고통·부상은 오른쪽으로만. 기존 단계 비율로 채운다", () => {
    expect(thermalBar("NONE", "NONE")).toMatchObject({ value: 0, text: "정상" });
    expect(thermalBar("COLD", "MILD")).toMatchObject({ value: -33, text: "경미", label: "추위" });
    expect(thermalBar("COLD", "EXTREME")).toMatchObject({ value: -100, text: "극심", label: "추위" });
    expect(thermalBar("HEAT", "SEVERE")).toMatchObject({ value: 67, text: "심함", label: "더위" });
    expect([painBar("NONE"), painBar("MILD"), painBar("EXTREME")].map((b) => b.value)).toEqual([0, 33, 100]);
    expect([injuryBar("NONE"), injuryBar("MILD"), injuryBar("MODERATE"), injuryBar("CRITICAL")].map((b) => b.value)).toEqual([0, 25, 50, 100]);
    expect(injuryBar("CRITICAL").text).toBe("위독");
  });

  it("현재 상태 카드: 정상이 아닌 항목만 (추위·더위 → 고통 → 부상)", () => {
    const normal = { thermalCause: "NONE", thermalLevel: "NONE", painLevel: "NONE", painCause: null, injury: "NONE", injuryCause: null } as const;
    const keys = (c: Parameters<typeof abnormalConditions>[0]) => abnormalConditions(c).map((a) => `${a.label}:${a.bar.value}`);
    expect(abnormalConditions(normal)).toEqual([]);
    expect(keys({ ...normal, thermalCause: "COLD", thermalLevel: "SEVERE" })).toEqual(["추위:-67"]);
    expect(keys({ ...normal, thermalCause: "HEAT", thermalLevel: "MILD" })).toEqual(["더위:33"]);
    expect(keys({ ...normal, painLevel: "EXTREME", painCause: "화상" })).toEqual(["고통:100"]);
    expect(abnormalConditions({ ...normal, injury: "MODERATE", injuryCause: "넘어짐" })).toEqual([{ key: "injury", label: "부상", bar: injuryBar("MODERATE"), detail: "넘어짐" }]);
    expect(keys({ thermalCause: "HEAT", thermalLevel: "EXTREME", painLevel: "MILD", painCause: null, injury: "CRITICAL", injuryCause: null })).toEqual(["더위:100", "고통:33", "부상:100"]);
  });
});
