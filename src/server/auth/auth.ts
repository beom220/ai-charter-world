import "server-only";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/server/db/client";
import { readAuthEnv } from "./env";
import { authOptions } from "./options";

// Better Auth 인스턴스 (architecture.md §11.1).
// 환경변수가 없어도 빌드·import는 되도록 첫 사용 시점에 만든다. 누락 시 AuthConfigError.

function createAuth() {
  const env = readAuthEnv(process.env);
  return betterAuth({
    ...authOptions(env, prisma),
    plugins: [nextCookies()], // 마지막 플러그인이어야 한다
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { __auth?: Auth };

export function getAuth(): Auth {
  globalForAuth.__auth ??= createAuth();
  return globalForAuth.__auth;
}
