import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAuthEnv } from "@/server/auth/env";
import { authOptions } from "@/server/auth/options";
import { requireUserFromHeaders } from "@/server/auth/session";
import { ownedByUser, requireOwnedWorld } from "@/server/db/scope";
import { prisma } from "@/server/db/client";
import { NotFoundError, UnauthorizedError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld } from "./helpers";

// 실제 Better Auth 인스턴스(공통 옵션 + 실제 DB)로 세션·소유권을 검증한다.
// Google 자격 증명은 더미 값이며 Google로 네트워크 요청을 보내지 않는다.
// 세션 생성은 공식 testUtils 플러그인을 쓴다 (테스트 전용 인스턴스에만 포함).

const BASE_URL = "https://app.example.test";
const env = readAuthEnv({
  BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: BASE_URL,
  GOOGLE_CLIENT_ID: "integration-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "integration-test-client-secret",
});

function createTestAuth(baseURL = BASE_URL) {
  return betterAuth({
    ...authOptions({ ...env, baseURL }, prisma),
    plugins: [testUtils(), nextCookies()],
  });
}

const auth = createTestAuth();
type TestAuth = typeof auth;

async function helpers(instance: TestAuth = auth) {
  return (await instance.$context).test;
}

async function login(userId: string) {
  return (await helpers()).login({ userId });
}

function post(path: string, body: unknown, headers: HeadersInit = {}) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function cookieHeader(name: string, value: string) {
  return new Headers({ cookie: `${name}=${value}` });
}

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("requireUser — 세션 검증", () => {
  it("세션 쿠키가 없으면 401", async () => {
    await expect(requireUserFromHeaders(new Headers(), auth)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("유효한 세션이면 그 사용자 ID를 반환한다", async () => {
    const user = await createTestUser("valid");
    const { headers } = await login(user.id);
    await expect(requireUserFromHeaders(headers, auth)).resolves.toEqual({ userId: user.id });
  });

  it("서명이 없거나 틀린 세션 쿠키는 401 (토큰 값을 알아도 위조 불가)", async () => {
    const user = await createTestUser("forge");
    const { token, cookies } = await login(user.id);
    const name = cookies[0]!.name;
    await expect(requireUserFromHeaders(cookieHeader(name, token), auth)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      requireUserFromHeaders(cookieHeader(name, encodeURIComponent(`${token}.AAAAforgedsignatureAAAA=`)), auth),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("만료된 세션은 401", async () => {
    const user = await createTestUser("expired");
    const { headers, session } = await login(user.id);
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(requireUserFromHeaders(headers, auth)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("무효화된 세션(DB에서 삭제)과 삭제된 사용자의 세션은 401", async () => {
    const revoked = await createTestUser("revoked");
    const r = await login(revoked.id);
    await prisma.session.delete({ where: { id: r.session.id } });
    await expect(requireUserFromHeaders(r.headers, auth)).rejects.toBeInstanceOf(UnauthorizedError);

    const gone = await createTestUser("gone");
    const g = await login(gone.id);
    await prisma.user.delete({ where: { id: gone.id } });
    await expect(requireUserFromHeaders(g.headers, auth)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("로그아웃하면 DB 세션이 삭제되고 쿠키가 만료되며 이후 요청은 401", async () => {
    const user = await createTestUser("signout");
    const { headers, session } = await login(user.id);

    const res = await post("/sign-out", {}, { cookie: headers.get("cookie")! });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).toMatch(/session_token=;.*Max-Age=0/i);
    expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
    await expect(requireUserFromHeaders(headers, auth)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("다른 origin에서 보낸 로그아웃(CSRF)은 403이고 세션은 유지된다", async () => {
    const user = await createTestUser("csrf");
    const { headers, session } = await login(user.id);

    const res = await post("/sign-out", {}, { cookie: headers.get("cookie")!, origin: "https://evil.example" });

    expect(res.status).toBe(403);
    expect(await prisma.session.findUnique({ where: { id: session.id } })).not.toBeNull();
    await expect(requireUserFromHeaders(headers, auth)).resolves.toEqual({ userId: user.id });
  });

  it("세션 없이 헤더로 사용자 ID를 주장해도 무시한다", async () => {
    const victim = await createTestUser("victim-h");
    const forged = new Headers({ "x-user-id": victim.id, authorization: `Bearer ${victim.id}`, cookie: `userId=${victim.id}` });
    await expect(requireUserFromHeaders(forged, auth)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("requireOwnedWorld — 소유권 검증", () => {
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let intruder: Awaited<ReturnType<typeof createTestUser>>;
  let ownerWorld: Awaited<ReturnType<typeof createTestWorld>>;

  beforeAll(async () => {
    owner = await createTestUser("owner");
    intruder = await createTestUser("intruder");
    ownerWorld = await createTestWorld(owner.id, "소유자 세계관");
  });

  it("자기 세계관은 조회된다", async () => {
    const { userId } = await requireUserFromHeaders((await login(owner.id)).headers, auth);
    await expect(requireOwnedWorld(userId, ownerWorld.id)).resolves.toMatchObject({ id: ownerWorld.id });
  });

  it("타인 세계관은 404이고, 존재하지 않는 세계관과 같은 응답이다", async () => {
    const { userId } = await requireUserFromHeaders((await login(intruder.id)).headers, auth);
    const other = await requireOwnedWorld(userId, ownerWorld.id).catch((e: unknown) => e);
    const missing = await requireOwnedWorld(userId, "does-not-exist").catch((e: unknown) => e);
    expect(other).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((other as NotFoundError).message).toBe((missing as NotFoundError).message);
  });

  it("요청 본문의 userId를 조작해도 세션 사용자로만 검사한다", async () => {
    // Route Handler 패턴: userId는 세션에서만 얻고, 본문의 userId는 쓰지 않는다
    const body = { userId: owner.id, worldId: ownerWorld.id };
    const attackerHeaders = new Headers((await login(intruder.id)).headers);
    attackerHeaders.set("x-user-id", body.userId);

    const { userId } = await requireUserFromHeaders(attackerHeaders, auth);
    expect(userId).toBe(intruder.id);
    await expect(requireOwnedWorld(userId, body.worldId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("세계관 하위 리소스도 world.ownerId 조건으로 타인 것을 찾지 못한다", async () => {
    const character = await prisma.character.create({ data: characterData(ownerWorld.id) });
    const asIntruder = await prisma.character.findFirst({
      where: { id: character.id, ...ownedByUser(asAuthenticatedUserId(intruder.id)) },
    });
    const asOwner = await prisma.character.findFirst({
      where: { id: character.id, ...ownedByUser(asAuthenticatedUserId(owner.id)) },
    });
    expect(asIntruder).toBeNull();
    expect(asOwner?.id).toBe(character.id);
  });

  it("클라이언트 문자열은 타입 수준에서 소유권 헬퍼에 넘길 수 없다", () => {
    const fromRequestBody: string = owner.id;
    // @ts-expect-error — string은 AuthenticatedUserId가 아니다 (pnpm typecheck가 검증)
    const call = () => requireOwnedWorld(fromRequestBody, ownerWorld.id);
    expect(typeof call).toBe("function");
  });
});

describe("Google 외 로그인 방식 비활성", () => {
  it("이메일 로그인·회원가입 엔드포인트는 거부되고 사용자·세션이 생기지 않는다", async () => {
    const email = `pw-${Date.now()}@example.test`;
    const signUp = await post("/sign-up/email", { email, password: "Password1234!", name: "pw" });
    const signIn = await post("/sign-in/email", { email, password: "Password1234!" });
    expect(signUp.status).toBe(400);
    expect(await signUp.json()).toMatchObject({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
    expect(signIn.status).toBe(400);
    expect(await signIn.json()).toMatchObject({ code: "EMAIL_PASSWORD_DISABLED" });
    expect(signUp.headers.getSetCookie().some((c) => c.includes("session_token=") && !c.includes("Max-Age=0"))).toBe(false);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("Google 외 소셜 Provider는 거부된다", async () => {
    for (const provider of ["github", "apple", "discord"]) {
      const res = await post("/sign-in/social", { provider, callbackURL: "/login" });
      expect(res.status, provider).toBe(404);
      expect(await res.json()).toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    }
    expect((await auth.$context).socialProviders.map((p) => p.id)).toEqual(["google"]);
  });

  it("Google 로그인 시작은 Google 인증 URL과 보안 state 쿠키를 반환한다 (네트워크 호출 없음)", async () => {
    const res = await post("/sign-in/social", { provider: "google", callbackURL: "/login" });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const authUrl = new URL(url);
    expect(authUrl.origin).toBe("https://accounts.google.com");
    expect(authUrl.searchParams.get("client_id")).toBe(env.google.clientId);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/api/auth/callback/google`);
    expect(authUrl.searchParams.get("state")).toBeTruthy();
    expect(url).not.toContain(env.google.clientSecret);

    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c).toMatch(/; HttpOnly/i);
      expect(c).toMatch(/; Secure/i);
      expect(c).toMatch(/; SameSite=Lax/i);
    }
  });
});

describe("세션 쿠키 보안 설정", () => {
  it("https: __Secure- 접두사, Secure, HttpOnly, SameSite=Lax, Path=/", async () => {
    const { sessionToken } = (await auth.$context).authCookies;
    expect(sessionToken.name).toBe("__Secure-better-auth.session_token");
    expect(sessionToken.attributes).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax", path: "/" });

    const user = await createTestUser("cookie");
    const cookies = await (await helpers()).getCookies({ userId: user.id });
    for (const c of cookies) expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  });

  it("로컬 http 개발 환경: Secure만 빠지고 HttpOnly·SameSite=Lax는 유지", async () => {
    const local = createTestAuth("http://localhost:3000");
    const { sessionToken } = (await local.$context).authCookies;
    expect(sessionToken.name).toBe("better-auth.session_token");
    expect(sessionToken.attributes).toMatchObject({ secure: false, httpOnly: true, sameSite: "lax" });
  });

  it("쿠키 캐시(session_data)를 쓰지 않는다 — 무효화가 즉시 반영된다", async () => {
    const user = await createTestUser("nocache");
    const { cookies } = await login(user.id);
    expect(cookies.map((c) => c.name)).toEqual(["__Secure-better-auth.session_token"]);
  });
});
