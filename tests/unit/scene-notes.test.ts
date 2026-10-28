import { describe, expect, it } from "vitest";
import { conditionTone, emotionCueText, josa, noteText, noteTone } from "@/lib/scene-notes";

// 대화 피드 사건·상태 메시지 분류와 표시 문구 (Phase 7-4)

describe("사건·상태 메시지 분류", () => {
  it("자동·사용자 사건은 같은 event(파랑)", () => {
    expect(noteTone({ kind: "EVENT_STARTED", text: "곰이 나타났다." })).toBe("event");
    expect(noteTone({ kind: "USER_EVENT_STARTED", text: "석상이 떨어졌다" })).toBe("event");
    expect(noteTone({ kind: "USER_EVENT_STARTED", tone: "event", text: "석상이 떨어졌다" })).toBe("event");
  });

  it("치료·회복·고통 완화는 positive, 부상·고통 증가·체온 악화는 negative", () => {
    expect(conditionTone("TREATMENT", "SEVERE", "MODERATE")).toBe("positive");
    expect(conditionTone("RECOVERY", "PAIN_SEVERE", "PAIN_MILD")).toBe("positive");
    expect(conditionTone("INJURY", "NONE", "MILD")).toBe("negative");
    expect(conditionTone("INJURY", "PAIN_MILD", "PAIN_SEVERE")).toBe("negative");
    expect(conditionTone("THERMAL", "NONE_NONE", "COLD_SEVERE")).toBe("negative");
    expect(conditionTone("THERMAL", "COLD_EXTREME", "COLD_MILD")).toBe("positive");
  });

  it("사망은 언제나 death(검정)", () => {
    expect(conditionTone("DEATH", "ALIVE", "DEAD")).toBe("death");
    expect(noteTone({ kind: "DEATH", tone: "negative", text: "x" })).toBe("death");
  });
});

describe("표시 문구", () => {
  it("기술적 접두어를 걷어 내고 본문·단계·원인은 남긴다", () => {
    expect(noteText("시스템 · 사건 발생: 거대한 곰이 야영지 근처에 나타났다.")).toBe("거대한 곰이 야영지 근처에 나타났다.");
    expect(noteText("사용자가 일으킨 사건: 석상이 떨어졌다")).toBe("석상이 떨어졌다");
    expect(noteText("새로운 사건 — 폭풍")).toBe("폭풍");
    expect(noteText("세계의 변화: 비가 그쳤다")).toBe("비가 그쳤다");
    expect(noteText("한서윤: 고통(심함) — 말라리아 감염으로 인한 고열과 두통")).toBe("한서윤: 고통(심함) — 말라리아 감염으로 인한 고열과 두통");
    expect(noteText("시스템이 고장 났다")).toBe("시스템이 고장 났다");
  });

  it("이름 받침에 맞는 조사", () => {
    expect(`한서윤${josa("한서윤", "이", "가")} 사망했다.`).toBe("한서윤이 사망했다.");
    expect(`민아${josa("민아", "이", "가")} 사망했다.`).toBe("민아가 사망했다.");
  });
});

describe("발언자 감정 표시", () => {
  it("영어 감정 코드·단어는 한국어로, 모르는 영어는 숨기고 한국어는 그대로", () => {
    expect(emotionCueText("ANXIOUS")).toBe("불안");
    expect(emotionCueText("nervous, curious")).toBe("긴장, 궁금함");
    expect(emotionCueText("slightly worried")).toBe("약간 걱정");
    expect(emotionCueText("궁금함")).toBe("궁금함");
    expect(emotionCueText("FEARFUL / 떨림")).toBe("두려움, 떨림");
    expect(emotionCueText("zxqv")).toBeNull();
    expect(emotionCueText(null)).toBeNull();
  });
});
