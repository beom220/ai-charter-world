// 통합 테스트는 Docker PostgreSQL(.env의 DATABASE_URL)을 사용한다.
try {
  process.loadEnvFile(".env");
} catch {
  // CI 등에서는 프로세스 환경변수를 그대로 쓴다.
}

if (!process.env.DATABASE_URL) {
  throw new Error("통합 테스트에는 DATABASE_URL이 필요합니다. `pnpm db:up` 후 .env를 확인하세요.");
}
