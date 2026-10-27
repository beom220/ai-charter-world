import { describe, expect, it } from "vitest";

describe("샘플 단위 테스트", () => {
  it("캐릭터 컨텍스트 길이는 코드 포인트 기준으로 센다", () => {
    const text = "가😀a";
    expect(text.length).toBe(4);
    expect(Array.from(text).length).toBe(3);
  });
});
