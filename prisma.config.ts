import { defineConfig } from "prisma/config";

// Prisma 7은 .env를 자동으로 읽지 않는다. dotenv 대신 Node 내장 로더를 쓴다.
try {
  process.loadEnvFile(".env");
} catch {
  // .env가 없으면 프로세스 환경변수만 사용한다 (CI 등).
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
