import { describe, expect, it } from "vitest";
import { abnormalConditions, emotionView, formatScore, relationView } from "@/lib/character-status";

// 캐릭터 상세 텍스트형 상태창: 저장 값 → 단계 문구·점수·색 톤 (UI 전용, 저장 값은 바꾸지 않는다)

const rel = (affinity: number, trust: number, respect: number, familiarity = 0) => ({ affinity, trust, respect, familiarity });

describe("관계", () => {
  it("점수는 호감·신뢰·존중 평균(반올림), 친밀도 제외. 기존 5단계와 톤", () => {
    expect(relationView(rel(0, 0, 0, 100))).toEqual({ stage: "보통", score: 0, tone: "neutral" });
    expect(relationView(rel(-100, -100, -100))).toEqual({ stage: "매우 나쁨", score: -100, tone: "negative" });
    expect(relationView(rel(-40, -30, -20))).toEqual({ stage: "나쁨", score: -30, tone: "negative" });
    expect(relationView(rel(40, 30, 20))).toEqual({ stage: "좋음", score: 30, tone: "positive" });
    expect(relationView(rel(100, 100, 100))).toEqual({ stage: "매우 좋음", score: 100, tone: "positive" });
    expect([rel(-60, -60, -60), rel(-59, -60, -60), rel(-19, -20, -20), rel(19, 20, 20), rel(20, 20, 20), rel(59, 60, 60), rel(60, 60, 60)].map((r) => relationView(r).stage)).toEqual([
      "매우 나쁨",
      "나쁨",
      "보통",
      "보통",
      "좋음",
      "좋음",
      "매우 좋음",
    ]);
    expect(relationView(rel(-1, 0, 0)).score).toBe(0); // -0 없이 0
    expect([82, 8, 0, -34].map(formatScore)).toEqual(["+82", "+8", "0", "-34"]);
  });
});

describe("감정", () => {
  it("문구는 강도 단계, 톤은 감정 방향(평온·차분 중립)", () => {
    expect(emotionView("ANXIOUS", 100)).toEqual({ text: "매우 강함", tone: "negative" });
    expect(emotionView("HAPPY", 50)).toEqual({ text: "보통", tone: "positive" });
    expect(emotionView("CALM", 70)).toEqual({ text: "강함", tone: "neutral" });
    expect(emotionView("UNKNOWN", 50).tone).toBe("neutral");
    for (const m of ["ANXIOUS", "SAD", "ANGRY", "FEARFUL", "LONELY", "EMBARRASSED", "TIRED"]) expect(emotionView(m, 40).tone).toBe("negative");
    for (const m of ["HAPPY", "EXCITED", "HOPEFUL"]) expect(emotionView(m, 40).tone).toBe("positive");
    expect([0, 20, 21, 40, 41, 60, 61, 80, 81, 100].map((v) => emotionView("HAPPY", v).text)).toEqual([
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
  it("현재 상태 카드: 정상이 아닌 항목만 (추위·더위 → 고통 → 부상), 기존 단계 문구", () => {
    const normal = { thermalCause: "NONE", thermalLevel: "NONE", painLevel: "NONE", painCause: null, injury: "NONE", injuryCause: null } as const;
    const rows = (c: Parameters<typeof abnormalConditions>[0]) => abnormalConditions(c).map((a) => `${a.label}:${a.text}`);
    expect(abnormalConditions(normal)).toEqual([]);
    expect(rows({ ...normal, thermalCause: "NONE", thermalLevel: "SEVERE" })).toEqual([]);
    expect(rows({ ...normal, thermalCause: "COLD", thermalLevel: "SEVERE" })).toEqual(["추위:심함"]);
    expect(rows({ ...normal, thermalCause: "HEAT", thermalLevel: "MILD" })).toEqual(["더위:경미"]);
    expect(abnormalConditions({ ...normal, injury: "MODERATE", injuryCause: "넘어짐" })).toEqual([{ key: "injury", label: "부상", text: "아픔", detail: "넘어짐" }]);
    expect(rows({ thermalCause: "HEAT", thermalLevel: "EXTREME", painLevel: "MILD", painCause: "고열", injury: "CRITICAL", injuryCause: null })).toEqual(["더위:극심", "고통:경미", "부상:위독"]);
  });
});
