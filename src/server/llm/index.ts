import { createGeminiSdkClient, type GeminiKeyClient } from "./gemini/client";
import { createMockGeminiClient } from "./mock/gemini-mock";

// LLM 제공자 선택 (architecture.md §8.1 폴백 금지).
// MockProvider는 NODE_ENV !== "production"이고 LLM_PROVIDER=mock일 때만 쓴다. 프로덕션에서 mock 설정이면 실패한다.

export class MockInProductionError extends Error {
  constructor() {
    super("프로덕션에서 LLM_PROVIDER=mock은 허용되지 않습니다.");
    this.name = "MockInProductionError";
  }
}

export function assertNoMockProviderInProduction(env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (env.NODE_ENV === "production" && env.LLM_PROVIDER === "mock") throw new MockInProductionError();
}

let cached: GeminiKeyClient | undefined;

export function getGeminiKeyClient(): GeminiKeyClient {
  if (cached) return cached;
  assertNoMockProviderInProduction();
  cached = process.env.LLM_PROVIDER === "mock" ? createMockGeminiClient().client : createGeminiSdkClient();
  return cached;
}
