import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PUT } from "@/app/api/providers/gemini/route";
import { AUTH_ENV_KEYS, readAuthEnv } from "@/server/auth/env";
import { authOptions } from "@/server/auth/options";
import { PROVIDER_CRYPTO_ENV_KEYS } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { cleanupTestUsers, createTestUser, fakeGeminiKey } from "./helpers";

// /api/providers/gemini Route Handler를 실제 Better Auth 세션 쿠키로 호출한다.
// 인증·암호화 환경변수는 이 파일에서만 더미 값으로 바꾼다(실제 비밀 값을 쓰지 않음).

const BASE_URL = "http://localhost:3000";
const ENV = {
  BETTER_AUTH_SECRET: "gemini-route-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: BASE_URL,
  GOOGLE_CLIENT_ID: "gemini-route-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "gemini-route-test-client-secret",
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "gemini-route-fingerprint-secret-0123456789",
};
const ENV_KEYS = [...AUTH_ENV_KEYS, ...PROVIDER_CRYPTO_ENV_KEYS];
const saved: Record<string, string | undefined> = {};

// 같은 비밀·같은 DB를 쓰는 테스트 전용 인스턴스로 세션을 만든다. 운영 인스턴스(getAuth)가 이 쿠키를 검증한다.
const testAuth = betterAuth({ ...authOptions(readAuthEnv(ENV), prisma), plugins: [testUtils()] });

type Logged = { all: () => string };
let logs: Logged;

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  delete (globalThis as { __auth?: unknown }).__auth; // 다른 파일에서 만든 인스턴스를 쓰지 않도록
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete (globalThis as { __auth?: unknown }).__auth;
  await cleanupTestUsers();
  await prisma.$disconnect();
});

// 모든 테스트에서 콘솔 출력을 모아 비밀 값 노출을 검사한다
const captured: string[] = [];
beforeAll(() => {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      captured.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : String(a))).join(" "));
    });
  }
  logs = { all: () => captured.join("\n") };
});

async function loginCookie(userId: string): Promise<string> {
  const { headers } = await (await testAuth.$context).test.login({ userId });
  return headers.get("cookie")!;
}

function request(method: "GET" | "PUT" | "DELETE", init: { cookie?: string; origin?: string | null; body?: unknown; rawBody?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.cookie) headers.set("cookie", init.cookie);
  const origin = init.origin === undefined ? BASE_URL : init.origin;
  if (origin) headers.set("origin", origin);
  const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return new Request(`${BASE_URL}/api/providers/gemini`, { method, headers, body });
}

const call = { GET, PUT, DELETE };
async function send(method: "GET" | "PUT" | "DELETE", init: Parameters<typeof request>[1] = {}) {
  const res = await call[method](request(method, init));
  const text = await res.text();
  return { status: res.status, cacheControl: res.headers.get("cache-control"), text, json: text ? JSON.parse(text) : null };
}

const allResponses: string[] = [];
async function sendTracked(...args: Parameters<typeof send>) {
  const r = await send(...args);
  allResponses.push(r.text);
  return r;
}

describe("설정 누락 (가장 먼저 실행)", () => {
  it("암호화 마스터 키가 없으면 500 SERVER_NOT_CONFIGURED, 로그에는 변수 이름만", async () => {
    const user = await createTestUser("noconfig");
    const cookie = await loginCookie(user.id);
    const masterKey = process.env.PROVIDER_KEY_ENCRYPTION_KEY;
    delete process.env.PROVIDER_KEY_ENCRYPTION_KEY;
    try {
      const r = await sendTracked("PUT", { cookie, body: { apiKey: fakeGeminiKey("noconfig") } });
      expect(r.status).toBe(500);
      expect(r.json).toEqual({ error: { code: "SERVER_NOT_CONFIGURED", message: "서버 설정이 완료되지 않았습니다." } });
      expect(logs.all()).toMatch(/PROVIDER_KEY_ENCRYPTION_KEY 누락/);
      expect(await prisma.aiProviderConnection.count({ where: { userId: user.id } })).toBe(0);
    } finally {
      process.env.PROVIDER_KEY_ENCRYPTION_KEY = masterKey;
    }
  });
});

describe("인증 — 비로그인 거부", () => {
  for (const method of ["GET", "PUT", "DELETE"] as const) {
    it(`${method} 쿠키 없음 → 401`, async () => {
      const r = await sendTracked(method, { body: method === "PUT" ? { apiKey: fakeGeminiKey("anon") } : undefined });
      expect(r.status).toBe(401);
      expect(r.json.error.code).toBe("UNAUTHORIZED");
    });
  }

  it("위조된(서명 없는) 세션 쿠키 → 401", async () => {
    const r = await sendTracked("GET", { cookie: "better-auth.session_token=forged-token-value" });
    expect(r.status).toBe(401);
  });
});

describe("등록·교체·조회·삭제", () => {
  let cookie: string;
  let userId: string;
  const firstKey = fakeGeminiKey("routeFirst");
  const secondKey = fakeGeminiKey("routeSecond");

  beforeAll(async () => {
    const user = await createTestUser("route");
    userId = user.id;
    cookie = await loginCookie(user.id);
  });

  it("등록 전 GET → connection: null", async () => {
    const r = await sendTracked("GET", { cookie });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ connection: null });
    expect(r.cacheControl).toBe("no-store");
  });

  it("PUT 등록 → 201, 응답에 키·암호문·IV·태그·지문이 없다", async () => {
    const r = await sendTracked("PUT", { cookie, body: { apiKey: firstKey } });
    expect(r.status).toBe(201);
    expect(r.json.created).toBe(true);
    expect(r.json.connection).toMatchObject({ provider: "GEMINI", status: "UNVERIFIED", keyLast4: firstKey.slice(-4), defaultModel: null });
    for (const field of ["encryptedKey", "keyIv", "keyAuthTag", "keyFingerprint", "encryptionKeyVersion", "id", "userId"]) {
      expect(r.json.connection).not.toHaveProperty(field);
    }
    expect(r.cacheControl).toBe("no-store");
  });

  it("PUT 교체 → 200, 연결 1개 유지", async () => {
    const r = await sendTracked("PUT", { cookie, body: { apiKey: secondKey } });
    expect(r.status).toBe(200);
    expect(r.json.created).toBe(false);
    expect(r.json.connection.keyLast4).toBe(secondKey.slice(-4));
    expect(await prisma.aiProviderConnection.count({ where: { userId } })).toBe(1);
  });

  it("GET → 현재 연결 상태", async () => {
    const r = await sendTracked("GET", { cookie });
    expect(r.json.connection).toMatchObject({ status: "UNVERIFIED", keyLast4: secondKey.slice(-4) });
  });

  it("형식이 틀린 키·JSON 오류 → 400, 응답에 입력값을 되돌려 주지 않는다", async () => {
    const wrong = `${secondKey}XYZ`;
    const bad = await sendTracked("PUT", { cookie, body: { apiKey: wrong } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("INVALID_REQUEST");
    expect(bad.text).not.toContain(wrong);
    const broken = await sendTracked("PUT", { cookie, rawBody: "{not json" });
    expect(broken.status).toBe(400);
    expect((await prisma.aiProviderConnection.findFirstOrThrow({ where: { userId } })).keyLast4).toBe(secondKey.slice(-4));
  });

  it("다른 origin의 PUT·DELETE(CSRF) → 403, 변경 없음", async () => {
    for (const origin of ["https://evil.example", null]) {
      expect((await sendTracked("PUT", { cookie, origin, body: { apiKey: firstKey } })).status).toBe(403);
      expect((await sendTracked("DELETE", { cookie, origin })).status).toBe(403);
    }
    expect((await prisma.aiProviderConnection.findFirstOrThrow({ where: { userId } })).keyLast4).toBe(secondKey.slice(-4));
  });

  it("DELETE → { deleted: true }, 다시 DELETE → { deleted: false }", async () => {
    expect((await sendTracked("DELETE", { cookie })).json).toEqual({ deleted: true });
    expect((await sendTracked("GET", { cookie })).json).toEqual({ connection: null });
    expect((await sendTracked("DELETE", { cookie })).json).toEqual({ deleted: false });
  });
});

describe("사용자 간 접근 차단", () => {
  it("본문의 userId를 무시하고, 다른 사용자의 연결을 조회·교체·삭제할 수 없다", async () => {
    const a = await createTestUser("route-a");
    const b = await createTestUser("route-b");
    const cookieA = await loginCookie(a.id);
    const cookieB = await loginCookie(b.id);
    const keyA = fakeGeminiKey("routeA");

    // A가 B의 userId를 본문에 넣어도 A 자신의 연결로 저장된다
    await sendTracked("PUT", { cookie: cookieA, body: { apiKey: keyA, userId: b.id } });
    expect(await prisma.aiProviderConnection.count({ where: { userId: b.id } })).toBe(0);
    const rowA = await prisma.aiProviderConnection.findFirstOrThrow({ where: { userId: a.id } });

    // B는 A의 연결을 볼 수 없고, 삭제·교체 요청은 B 자신에게만 적용된다
    expect((await sendTracked("GET", { cookie: cookieB })).json).toEqual({ connection: null });
    expect((await sendTracked("DELETE", { cookie: cookieB, body: { userId: a.id } })).json).toEqual({ deleted: false });
    await sendTracked("PUT", { cookie: cookieB, body: { apiKey: fakeGeminiKey("routeB"), userId: a.id } });

    const afterA = await prisma.aiProviderConnection.findFirstOrThrow({ where: { userId: a.id } });
    expect(afterA.id).toBe(rowA.id);
    expect(afterA.keyFingerprint).toBe(rowA.keyFingerprint);
    expect(await prisma.aiProviderConnection.count({ where: { userId: b.id } })).toBe(1);
  });
});

describe("비밀 값 노출 점검 (위 모든 요청 대상)", () => {
  it("응답·로그에 API 키, 마스터 키, 지문 비밀, 암호문·지문이 없다", async () => {
    const rows = await prisma.aiProviderConnection.findMany({ select: { encryptedKey: true, keyFingerprint: true } });
    const forbidden = [
      ENV.PROVIDER_KEY_ENCRYPTION_KEY,
      ENV.KEY_FINGERPRINT_SECRET,
      ENV.BETTER_AUTH_SECRET,
      ...["routeFirst", "routeSecond", "routeA", "routeB", "anon", "noconfig"].map(fakeGeminiKey),
      ...rows.flatMap((r) => [r.keyFingerprint, Buffer.from(r.encryptedKey).toString("base64"), Buffer.from(r.encryptedKey).toString("hex")]),
    ];
    const haystack = `${allResponses.join("\n")}\n${logs.all()}`;
    expect(allResponses.length).toBeGreaterThan(15);
    for (const secret of forbidden) expect(haystack.includes(secret)).toBe(false);
    expect(haystack).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
  });
});
