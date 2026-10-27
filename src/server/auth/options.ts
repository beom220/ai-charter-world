import "server-only";
import type { BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { PrismaClient } from "@/generated/prisma/client";
import { redactSecrets } from "@/server/logging/redact";
import type { AuthEnv } from "./env";

// Better Auth 공통 옵션. 실제 인스턴스(auth.ts)와 테스트 인스턴스가 같은 옵션을 쓴다.
// - Google OAuth만 사용 (CLAUDE.md 절대 규칙 2): emailAndPassword 비활성, socialProviders는 google만
// - 세션은 DB에서 매번 검증 (cookieCache 미사용) → 로그아웃·무효화가 즉시 반영된다

export function authOptions(env: AuthEnv, db: PrismaClient) {
  const knownSecrets = [env.secret, env.google.clientSecret];
  return {
    appName: "AI Character World",
    baseURL: env.baseURL,
    secret: env.secret,
    database: prismaAdapter(db, { provider: "postgresql" }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.google.clientId,
        clientSecret: env.google.clientSecret,
      },
    },
    session: {
      cookieCache: { enabled: false },
    },
    advanced: {
      // https 배포에서는 Secure·__Secure- 접두사 쿠키. 로컬 http 개발에서만 Secure 없이 동작한다.
      useSecureCookies: env.baseURL.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      // Better Auth는 NODE_ENV=test에서 origin 검사를 기본으로 끈다. 모든 환경에서 켜 두어 테스트가 운영과 같게 동작한다.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    logger: {
      level: "warn",
      // 추가 인자(요청·토큰 객체가 담길 수 있음)는 버리고, 메시지에서 비밀 값을 지운다.
      log: (level, message) => {
        const line = `[auth] ${redactSecrets(message, knownSecrets)}`;
        if (level === "error") console.error(line);
        else console.warn(line);
      },
    },
  } satisfies BetterAuthOptions;
}
