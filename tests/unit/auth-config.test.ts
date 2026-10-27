import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { AUTH_ENV_KEYS, AuthConfigError, readAuthEnv } from "@/server/auth/env";
import { authOptions } from "@/server/auth/options";
import { redactSecrets } from "@/server/logging/redact";

const SECRET = "unit-test-secret-0123456789abcdefghij";
// 실제 비밀이 아닌 가짜 값. 비밀 스캐너 오탐을 피하려고 형식 접두사를 런타임에 붙인다.
const CLIENT_SECRET = ["GOCSPX", "unit-test-client-secret"].join("-");
const FAKE_API_KEY = ["AIza", "SyA1234567890abcdefghijklmnop"].join("");
const validEnv = {
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: "https://app.example.test",
  GOOGLE_CLIENT_ID: "unit-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
};

describe("인증 환경변수 검증", () => {
  it("모든 값이 있으면 설정을 반환한다", () => {
    expect(readAuthEnv(validEnv)).toEqual({
      secret: SECRET,
      baseURL: "https://app.example.test",
      google: { clientId: validEnv.GOOGLE_CLIENT_ID, clientSecret: CLIENT_SECRET },
    });
  });

  it("누락된 변수를 모두 이름으로 알려 준다", () => {
    try {
      readAuthEnv({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthConfigError);
      expect((error as AuthConfigError).problems).toEqual(AUTH_ENV_KEYS.map((k) => `${k} 누락`));
    }
  });

  it("공백만 있는 값도 누락으로 본다", () => {
    expect(() => readAuthEnv({ ...validEnv, GOOGLE_CLIENT_ID: "  " })).toThrow(/GOOGLE_CLIENT_ID 누락/);
  });

  it("짧은 비밀 값과 잘못된 URL을 거부하되, 오류 메시지에 값을 담지 않는다", () => {
    const shortSecret = "short-secret-value";
    try {
      readAuthEnv({ ...validEnv, BETTER_AUTH_SECRET: shortSecret, BETTER_AUTH_URL: "localhost:3000" });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/BETTER_AUTH_SECRET는 32자 이상/);
      expect(message).toMatch(/BETTER_AUTH_URL은 http\(s\)/);
      expect(message).not.toContain(shortSecret);
      expect(message).not.toContain(CLIENT_SECRET);
    }
  });
});

describe("로그 마스킹", () => {
  it("알려진 비밀 값과 비밀 형태 문자열을 지운다", () => {
    const line = redactSecrets(
      `secret=${SECRET} client=${CLIENT_SECRET} key=${FAKE_API_KEY} Authorization: bearer abc.def= cookie better-auth.session_token=tok.sig; __Secure-better-auth.state=xyz`,
      [SECRET],
    );
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("GOCSPX-");
    expect(line).not.toContain("AIzaSy");
    expect(line).not.toContain("abc.def=");
    expect(line).not.toContain("tok.sig");
    expect(line).not.toContain("xyz");
    expect(line).toContain("better-auth.session_token=[REDACTED]");
  });
});

describe("Better Auth 공통 옵션", () => {
  const options = authOptions(readAuthEnv(validEnv), {} as PrismaClient);

  afterEach(() => vi.restoreAllMocks());

  it("Google OAuth만 켠다: 이메일·비밀번호 비활성, 소셜 Provider는 google 하나", () => {
    expect(options.emailAndPassword.enabled).toBe(false);
    expect(Object.keys(options.socialProviders)).toEqual(["google"]);
  });

  it("세션을 매 요청 DB에서 검증한다 (쿠키 캐시 비활성)", () => {
    expect(options.session.cookieCache.enabled).toBe(false);
  });

  it("https 기준 URL이면 Secure 쿠키, 항상 HttpOnly·SameSite=Lax", () => {
    expect(options.advanced.useSecureCookies).toBe(true);
    expect(options.advanced.defaultCookieAttributes).toEqual({ httpOnly: true, sameSite: "lax", path: "/" });
    const local = authOptions(readAuthEnv({ ...validEnv, BETTER_AUTH_URL: "http://localhost:3000" }), {} as PrismaClient);
    expect(local.advanced.useSecureCookies).toBe(false);
  });

  it("origin·CSRF 검사를 명시적으로 켠다 (Better Auth의 테스트 환경 기본값에 의존하지 않음)", () => {
    expect(options.advanced.disableOriginCheck).toBe(false);
    expect(options.advanced.disableCSRFCheck).toBe(false);
  });

  it("로거는 비밀 값을 지우고 추가 인자(객체)를 버린다", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Better Auth는 log(level, message, ...args)로 호출한다 (Logger 타입)
    const log = options.logger.log as (level: "error" | "warn", message: string, ...args: unknown[]) => void;
    log("error", `failed with secret ${SECRET} and ${CLIENT_SECRET}`, { accessToken: "ya29.leak" });
    log("warn", "token=abc123");

    const logged = [...error.mock.calls, ...warn.mock.calls].map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(CLIENT_SECRET);
    expect(logged).not.toContain("ya29.leak");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[auth\] failed with secret \[REDACTED\]/));
  });
});
