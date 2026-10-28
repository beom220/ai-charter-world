// 서버 부팅 시 1회 실행 (Next.js instrumentation).
// 프로덕션에서 mock LLM 설정이 감지되면 부팅을 실패시킨다 (CLAUDE.md 절대 규칙 1).
// 이어서 같은 프로세스에서 시뮬레이션 RunnerHost를 시작한다 (architecture.md §7.7 MVP). `next build` 중에는 시작하지 않는다.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertNoMockProviderInProduction } = await import("@/server/llm");
    assertNoMockProviderInProduction();
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      const { startRunnerHost } = await import("@/server/engine/runner/host");
      await startRunnerHost();
    }
  }
}
