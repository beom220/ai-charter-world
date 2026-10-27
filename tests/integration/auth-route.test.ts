import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/auth/[...all]/route";
import { AUTH_ENV_KEYS } from "@/server/auth/env";
import { prisma } from "@/server/db/client";

// src/app/api/auth/[...all]/route.ts를 직접 호출한다.
// 순서가 중요하다: 인증 인스턴스는 첫 성공 시점에 캐시되므로 "누락" 테스트를 먼저 실행한다.

const BASE_URL = "http://localhost:3000";
const DUMMY = {
  BETTER_AUTH_SECRET: "route-test-secret-0123456789abcdefghijkl",
  BETTER_AUTH_URL: BASE_URL,
  GOOGLE_CLIENT_ID: "route-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "route-test-client-secret-value",
};
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of AUTH_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(async () => {
  for (const key of AUTH_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await prisma.$disconnect();
});

const req = (path: string, init?: RequestInit) => new Request(`${BASE_URL}/api/auth${path}`, init);

describe("인증 Route Handler", () => {
  it("환경변수가 없으면 500 AUTH_NOT_CONFIGURED, 로그에는 변수 이름만 남는다", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.GOOGLE_CLIENT_SECRET = DUMMY.GOOGLE_CLIENT_SECRET; // 일부만 있는 상황

    const res = await GET(req("/get-session"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "AUTH_NOT_CONFIGURED", message: "인증 설정이 완료되지 않았습니다." },
    });
    const logged = error.mock.calls.flat().join("\n");
    expect(logged).toMatch(/BETTER_AUTH_SECRET 누락/);
    expect(logged).toMatch(/GOOGLE_CLIENT_ID 누락/);
    expect(logged).not.toMatch(/GOOGLE_CLIENT_SECRET 누락/);
    expect(logged).not.toContain(DUMMY.GOOGLE_CLIENT_SECRET);
    error.mockRestore();
  });

  it("환경변수가 있으면 세션 조회·Google 시작이 동작하고 이메일 로그인은 거부된다", async () => {
    Object.assign(process.env, DUMMY);

    const session = await GET(req("/get-session"));
    expect(session.status).toBe(200);
    expect(await session.json()).toBeNull();

    const post = (path: string, body: unknown) =>
      POST(req(path, { method: "POST", headers: { "content-type": "application/json", origin: BASE_URL }, body: JSON.stringify(body) }));

    const google = await post("/sign-in/social", { provider: "google", callbackURL: "/login" });
    expect(google.status).toBe(200);
    expect(new URL(((await google.json()) as { url: string }).url).origin).toBe("https://accounts.google.com");

    const email = await post("/sign-in/email", { email: "x@example.test", password: "Password1234!" });
    expect(email.status).toBe(400);
  });

  it("다른 origin의 상태 변경 요청은 거부된다 (CSRF)", async () => {
    const res = await POST(
      req("/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example", cookie: "better-auth.session_token=x" },
        body: JSON.stringify({ provider: "google", callbackURL: "/login" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
