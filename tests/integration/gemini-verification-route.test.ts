import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PUT as putModel } from "@/app/api/providers/gemini/model/route";
import { GET as getModels } from "@/app/api/providers/gemini/models/route";
import { PUT as putKey } from "@/app/api/providers/gemini/route";
import { POST as postVerify } from "@/app/api/providers/gemini/verify/route";
import { AUTH_ENV_KEYS, readAuthEnv } from "@/server/auth/env";
import { authOptions } from "@/server/auth/options";
import { PROVIDER_CRYPTO_ENV_KEYS } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { cleanupTestUsers, createTestUser, fakeGeminiKey } from "./helpers";

// 검증·모델 목록·모델 선택 Route Handler. LLM_PROVIDER=mock으로 외부 호출 없이 실행한다.
const BASE_URL = "http://localhost:3000";
const ENV = {
  BETTER_AUTH_SECRET: "verify-route-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: BASE_URL,
  GOOGLE_CLIENT_ID: "verify-route-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "verify-route-test-client-secret",
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "verify-route-fingerprint-secret-0123456789",
  LLM_PROVIDER: "mock",
};
const ENV_KEYS = [...AUTH_ENV_KEYS, ...PROVIDER_CRYPTO_ENV_KEYS, "LLM_PROVIDER"];
const saved: Record<string, string | undefined> = {};
const testAuth = betterAuth({ ...authOptions(readAuthEnv(ENV), prisma), plugins: [testUtils()] });
const captured: string[] = [];
const responses: string[] = [];

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  delete (globalThis as { __auth?: unknown }).__auth;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void captured.push(args.map(String).join(" ")));
  }
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

async function cookieFor(userId: string) {
  return (await (await testAuth.$context).test.login({ userId })).headers.get("cookie")!;
}

type Handler = (r: Request) => Promise<Response>;
async function send(handler: Handler, path: string, method: string, init: { cookie?: string; origin?: string | null; body?: unknown } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.cookie) headers.set("cookie", init.cookie);
  const origin = init.origin === undefined ? BASE_URL : init.origin;
  if (origin) headers.set("origin", origin);
  const res = await handler(new Request(`${BASE_URL}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }));
  const text = await res.text();
  responses.push(text);
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

const verify = (init: Parameters<typeof send>[3] = {}) => send(postVerify, "/api/providers/gemini/verify", "POST", init);
const models = (init: Parameters<typeof send>[3] = {}) => send(getModels, "/api/providers/gemini/models", "GET", init);
const select = (init: Parameters<typeof send>[3] = {}) => send(putModel, "/api/providers/gemini/model", "PUT", init);

describe("인증·CSRF", () => {
  it("비로그인 → 401 (검증·목록·선택)", async () => {
    expect((await verify()).status).toBe(401);
    expect((await models()).status).toBe(401);
    expect((await select({ body: { model: "gemini-mock-flash" } })).status).toBe(401);
  });

  it("다른 origin의 검증·선택 → 403", async () => {
    const user = await createTestUser("vr-csrf");
    const cookie = await cookieFor(user.id);
    expect((await verify({ cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await select({ cookie, origin: null, body: { model: "gemini-mock-flash" } })).status).toBe(403);
  });
});

describe("검증 → 목록 → 선택 흐름", () => {
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    const user = await createTestUser("vr-flow");
    userId = user.id;
    cookie = await cookieFor(user.id);
  });

  it("연결이 없으면 검증 404", async () => {
    expect((await verify({ cookie })).status).toBe(404);
  });

  it("등록 직후 목록·선택은 409 GEMINI_NOT_VERIFIED", async () => {
    await send(putKey, "/api/providers/gemini", "PUT", { cookie, body: { apiKey: fakeGeminiKey("vrflow") } });
    expect((await models({ cookie })).json.error.code).toBe("GEMINI_NOT_VERIFIED");
    const r = await select({ cookie, body: { model: "gemini-mock-flash" } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("GEMINI_NOT_VERIFIED");
  });

  it("검증 → 200 ok, ACTIVE, 선택 가능 모델 목록", async () => {
    const r = await verify({ cookie });
    expect(r.status).toBe(200);
    expect(r.json.verification).toEqual({ ok: true });
    expect(r.json.connection.status).toBe("ACTIVE");
    expect(r.json.models.map((m: { id: string }) => m.id)).toEqual(["gemini-mock-flash", "gemini-mock-pro"]);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("목록 새로고침 → 200 models", async () => {
    const r = await models({ cookie });
    expect(r.status).toBe(200);
    expect(r.json.models).toHaveLength(2);
  });

  it("모델 ID 형식 오류 → 400, 사용 불가 모델 → 422, 정상 → 200 defaultModel", async () => {
    expect((await select({ cookie, body: { model: "Bad Model!" } })).status).toBe(400);
    expect((await select({ cookie, body: {} })).status).toBe(400);
    const unsupported = await select({ cookie, body: { model: "gemini-mock-embedding" } });
    expect(unsupported.status).toBe(422);
    expect(unsupported.json.error.code).toBe("GEMINI_MODEL_NOT_SUPPORTED");
    const missing = await select({ cookie, body: { model: "gemini-unknown" } });
    expect(missing.json.error.code).toBe("GEMINI_MODEL_NOT_FOUND");

    const ok = await select({ cookie, body: { model: "models/gemini-mock-flash" } }); // 접두사는 떼고 저장
    expect(ok.status).toBe(200);
    expect(ok.json.connection.defaultModel).toBe("gemini-mock-flash");
  });

  it("키를 교체하면 검증 상태가 무효화되어 선택이 다시 막힌다", async () => {
    await send(putKey, "/api/providers/gemini", "PUT", { cookie, body: { apiKey: fakeGeminiKey("vrflow2") } });
    const r = await select({ cookie, body: { model: "gemini-mock-pro" } });
    expect(r.json.error.code).toBe("GEMINI_NOT_VERIFIED");
    expect((await prisma.aiProviderConnection.findFirstOrThrow({ where: { userId } })).status).toBe("UNVERIFIED");
  });

  it("호출 한도를 넘으면 429 RATE_LIMITED + Retry-After", async () => {
    let last;
    for (let i = 0; i < 12; i++) last = await verify({ cookie });
    expect(last!.status).toBe(429);
    expect(last!.json.error.code).toBe("RATE_LIMITED");
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("비밀 값 노출", () => {
  it("모든 응답·로그에 API 키·마스터 키·지문 비밀이 없다", () => {
    const haystack = `${responses.join("\n")}\n${captured.join("\n")}`;
    for (const secret of [fakeGeminiKey("vrflow"), fakeGeminiKey("vrflow2"), ENV.PROVIDER_KEY_ENCRYPTION_KEY, ENV.KEY_FINGERPRINT_SECRET, ENV.BETTER_AUTH_SECRET]) {
      expect(haystack.includes(secret)).toBe(false);
    }
    expect(haystack).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    expect(haystack).not.toMatch(/keyFingerprint|encryptedKey|keyIv|keyAuthTag/);
  });
});
