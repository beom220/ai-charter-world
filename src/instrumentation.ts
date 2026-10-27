// 서버 부팅 시 1회 실행 (Next.js instrumentation).
// 프로덕션에서 mock LLM 설정이 감지되면 부팅을 실패시킨다 (CLAUDE.md 절대 규칙 1).

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertNoMockProviderInProduction } = await import("@/server/llm");
    assertNoMockProviderInProduction();
  }
}
