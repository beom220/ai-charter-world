import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PROVIDER_CHECK_RATE_LIMIT } from "../../config/limits";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import {
  ConnectionNotReadyError,
  GeminiRequestError,
  ModelUnavailableError,
  listGeminiModels,
  ProviderRateLimitError,
  requireUsableGeminiConnection,
  selectGeminiModel,
  UnsupportedModelError,
  verifyGeminiConnection,
} from "@/server/domain/providers/gemini-verification";
import { createMockGeminiClient, MOCK_GEMINI_MODELS, type MockGeminiScript } from "@/server/llm/mock/gemini-mock";
import { cleanupTestUsers, createTestUser, fakeGeminiKey } from "./helpers";

// 키 검증·모델 목록·모델 선택 서비스 (실제 DB + Mock Gemini 클라이언트).
const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "verification-fingerprint-secret-0123456789",
});

async function setup(label: string, script: MockGeminiScript = {}) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  const apiKey = fakeGeminiKey(label);
  await saveGeminiApiKey(uid, apiKey, material);
  const mock = createMockGeminiClient(script);
  return { user, uid, apiKey, mock, deps: { client: mock.client, material } };
}

const row = (userId: string) => prisma.aiProviderConnection.findFirstOrThrow({ where: { userId } });
const logs = (userId: string) => prisma.apiRequestLog.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("키 검증", () => {
  it("유효한 키 → ACTIVE, 검증 시각 기록, 선택 가능 모델만 반환, 외부 호출 1회 기록", async () => {
    const { user, uid, deps, mock } = await setup("valid");
    const result = await verifyGeminiConnection(uid, deps);

    expect(result.verification).toEqual({ ok: true });
    expect(result.connection.status).toBe("ACTIVE");
    expect(result.connection.lastVerifiedAt).toBeInstanceOf(Date);
    expect(result.models.map((m) => m.id)).toEqual(["gemini-mock-flash", "gemini-mock-pro"]); // 임베딩 제외
    expect(result.modelReselectRequired).toBe(false);
    expect(mock.calls).toHaveLength(1);
    expect(await logs(user.id)).toMatchObject([{ model: "(models.list)", outcome: "SUCCESS", httpStatus: 200, errorCode: null }]);
  });

  it("잘못된 키 → INVALID, lastErrorCode=KEY_INVALID, 이해 가능한 메시지", async () => {
    const { user, uid, apiKey, deps } = await setup("invalid");
    const mock = createMockGeminiClient({ failKeys: { [apiKey]: "KEY_INVALID" } });
    const result = await verifyGeminiConnection(uid, { ...deps, client: mock.client });

    expect(result.verification).toMatchObject({ ok: false, code: "KEY_INVALID" });
    expect((result.verification as { message: string }).message).toMatch(/API 키가 유효하지 않습니다/);
    expect(result.connection).toMatchObject({ status: "INVALID", lastErrorCode: "KEY_INVALID", lastVerifiedAt: null });
    expect(await logs(user.id)).toMatchObject([{ outcome: "HTTP_ERROR", httpStatus: 400, errorCode: "KEY_INVALID" }]);
  });

  it("권한·지역 제한(403) → INVALID", async () => {
    const { uid, apiKey, deps } = await setup("forbidden");
    const result = await verifyGeminiConnection(uid, { ...deps, client: createMockGeminiClient({ failKeys: { [apiKey]: "PERMISSION_DENIED" } }).client });
    expect(result.connection).toMatchObject({ status: "INVALID", lastErrorCode: "PERMISSION_DENIED" });
  });

  for (const kind of ["QUOTA_EXCEEDED", "UPSTREAM_ERROR", "NETWORK_ERROR", "TIMEOUT"] as const) {
    it(`일시적 오류 ${kind} → 상태 유지(INVALID로 바꾸지 않음), lastErrorCode만 기록`, async () => {
      const { user, uid, apiKey, deps } = await setup(`transient-${kind}`);
      const result = await verifyGeminiConnection(uid, { ...deps, client: createMockGeminiClient({ failKeys: { [apiKey]: kind } }).client });
      expect(result.verification).toMatchObject({ ok: false, code: kind });
      expect(result.connection).toMatchObject({ status: "UNVERIFIED", lastErrorCode: kind });
      const [log] = await logs(user.id);
      expect(log!.outcome).toBe(kind === "NETWORK_ERROR" || kind === "TIMEOUT" ? "NETWORK_ERROR" : "HTTP_ERROR");
    });
  }

  it("이미 ACTIVE인 연결에 일시적 오류가 나도 ACTIVE를 유지한다", async () => {
    const { uid, apiKey, deps } = await setup("keep-active");
    await verifyGeminiConnection(uid, deps);
    const result = await verifyGeminiConnection(uid, { ...deps, client: createMockGeminiClient({ failKeys: { [apiKey]: "UPSTREAM_ERROR" } }).client });
    expect(result.connection).toMatchObject({ status: "ACTIVE", lastErrorCode: "UPSTREAM_ERROR" });
  });

  it("연결이 없으면 404이고 외부 호출하지 않는다", async () => {
    const user = await createTestUser("noconn");
    const mock = createMockGeminiClient();
    await expect(verifyGeminiConnection(asAuthenticatedUserId(user.id), { client: mock.client, material })).rejects.toBeInstanceOf(NotFoundError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("키 교체 후 재검증 의무", () => {
  it("교체하면 UNVERIFIED로 돌아가 모델 사용이 막히고, 재검증해야 다시 쓸 수 있다", async () => {
    const { uid, deps } = await setup("replace");
    await verifyGeminiConnection(uid, deps);
    await selectGeminiModel(uid, "gemini-mock-flash", deps);
    await expect(requireUsableGeminiConnection(uid)).resolves.toMatchObject({ modelId: "gemini-mock-flash" });

    await saveGeminiApiKey(uid, fakeGeminiKey("replace2"), material);
    expect((await row(uid)).status).toBe("UNVERIFIED");
    await expect(requireUsableGeminiConnection(uid)).rejects.toMatchObject({ code: "GEMINI_NOT_VERIFIED" });
    await expect(selectGeminiModel(uid, "gemini-mock-flash", deps)).rejects.toMatchObject({ code: "GEMINI_NOT_VERIFIED" });

    const again = await verifyGeminiConnection(uid, deps);
    expect(again.connection).toMatchObject({ status: "ACTIVE", defaultModel: "gemini-mock-flash" }); // 새 키에서도 쓸 수 있는 모델이면 유지
    expect(again.modelReselectRequired).toBe(false);
    await expect(requireUsableGeminiConnection(uid)).resolves.toBeTruthy();
  });

  it("기존 모델을 새 키로 쓸 수 없으면 비우고 재선택을 요구한다", async () => {
    const { uid, deps } = await setup("reselect");
    await verifyGeminiConnection(uid, deps);
    await selectGeminiModel(uid, "gemini-mock-pro", deps);
    await saveGeminiApiKey(uid, fakeGeminiKey("reselect2"), material);

    const onlyFlash = createMockGeminiClient({ models: MOCK_GEMINI_MODELS.filter((m) => m.id !== "gemini-mock-pro") });
    const result = await verifyGeminiConnection(uid, { ...deps, client: onlyFlash.client });

    expect(result.modelReselectRequired).toBe(true);
    expect(result.connection).toMatchObject({ status: "ACTIVE", defaultModel: null });
    await expect(requireUsableGeminiConnection(uid)).rejects.toMatchObject({ code: "GEMINI_MODEL_NOT_SELECTED" });
  });

  it("검증 도중 키가 교체되면 이전 키의 결과를 반영하지 않는다 (지문 펜싱)", async () => {
    const { uid, deps } = await setup("fence", { delayMs: 150 });
    const pending = verifyGeminiConnection(uid, deps);
    await new Promise((r) => setTimeout(r, 30));
    await saveGeminiApiKey(uid, fakeGeminiKey("fence2"), material); // 검증 진행 중 교체

    const result = await pending;
    expect(result.verification).toMatchObject({ ok: false, code: "KEY_CHANGED" });
    expect((await row(uid)).status).toBe("UNVERIFIED");
  });
});

describe("모델 선택", () => {
  it("미검증 연결은 선택할 수 없고 외부 호출도 하지 않는다", async () => {
    const { uid, deps, mock } = await setup("select-unverified");
    await expect(selectGeminiModel(uid, "gemini-mock-flash", deps)).rejects.toBeInstanceOf(ConnectionNotReadyError);
    expect(mock.calls).toHaveLength(0);
  });

  it("성공: 모델 확인 + 최소 생성 요청(2회) 후 defaultModel 저장, 토큰 기록", async () => {
    const { user, uid, deps, mock } = await setup("select-ok");
    await verifyGeminiConnection(uid, deps);
    const connection = await selectGeminiModel(uid, "gemini-mock-flash", deps);

    expect(connection.defaultModel).toBe("gemini-mock-flash");
    expect(mock.calls.map((c) => c.operation)).toEqual(["models.list", "models.get", "models.generateContent"]);
    const probe = (await logs(user.id)).find((l) => l.model === "gemini-mock-flash" && l.inputTokens !== null);
    expect(probe).toMatchObject({ outcome: "SUCCESS", inputTokens: 1, outputTokens: 1 });
  });

  it("대화 생성을 지원하지 않는 모델은 거부하고(생성 요청 없음) 기존 선택을 유지한다", async () => {
    const { uid, deps, mock } = await setup("select-unsupported");
    await verifyGeminiConnection(uid, deps);
    await selectGeminiModel(uid, "gemini-mock-flash", deps);
    const before = mock.calls.length;

    await expect(selectGeminiModel(uid, "gemini-mock-embedding", deps)).rejects.toBeInstanceOf(UnsupportedModelError);
    expect(mock.calls.slice(before).map((c) => c.operation)).toEqual(["models.get"]);
    expect((await row(uid)).defaultModel).toBe("gemini-mock-flash");
  });

  it("존재하지 않는 모델 → 422 GEMINI_MODEL_NOT_FOUND", async () => {
    const { uid, deps } = await setup("select-missing");
    await verifyGeminiConnection(uid, deps);
    const error = await selectGeminiModel(uid, "gemini-does-not-exist", deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiRequestError);
    expect(error).toMatchObject({ status: 422, code: "GEMINI_MODEL_NOT_FOUND" });
  });

  for (const kind of ["MODEL_NOT_FOUND", "PERMISSION_DENIED", "BAD_REQUEST"] as const) {
    it(`모델 정보는 조회되지만 생성 요청이 ${kind}이면 GEMINI_MODEL_UNAVAILABLE, 모델·연결 상태 유지`, async () => {
      const { user, uid, deps } = await setup(`select-unavail-${kind}`);
      await verifyGeminiConnection(uid, deps);
      const mock = createMockGeminiClient({ failProbe: { "gemini-mock-pro": kind } });
      const error = await selectGeminiModel(uid, "gemini-mock-pro", { ...deps, client: mock.client }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ModelUnavailableError);
      expect(error).toMatchObject({ status: 422, code: "GEMINI_MODEL_UNAVAILABLE" });
      expect((error as Error).message).not.toMatch(/찾을 수 없/); // 원인을 단정하지 않는다
      expect(mock.calls.map((c) => c.operation)).toEqual(["models.get", "models.generateContent"]); // 추가 호출·재시도 없음
      expect(await row(uid)).toMatchObject({ defaultModel: null, status: "ACTIVE" });
      const failed = (await logs(user.id)).at(-1)!;
      expect(failed).toMatchObject({ model: "gemini-mock-pro", errorCode: kind, outcome: "HTTP_ERROR" });
      expect(failed.errorMessage).toMatch(/^status=[A-Z_]+/); // 안전한 토큰만
    });
  }

  it("생성 응답이 완료되지 않으면(INCOMPLETE_RESPONSE) 모델을 저장하지 않고, 쓰인 토큰은 VALIDATION_ERROR로 기록한다", async () => {
    const { user, uid, deps } = await setup("select-incomplete");
    await verifyGeminiConnection(uid, deps);
    const mock = createMockGeminiClient({ failProbe: { "gemini-mock-flash": "INCOMPLETE_RESPONSE" } });
    const error = await selectGeminiModel(uid, "gemini-mock-flash", { ...deps, client: mock.client }).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 422, code: "GEMINI_INCOMPLETE_RESPONSE" });
    expect(mock.calls).toHaveLength(2); // models.get + generateContent 1회, 재시도 없음
    expect(await row(uid)).toMatchObject({ defaultModel: null, status: "ACTIVE" });
    const probe = (await logs(user.id)).at(-1)!;
    expect(probe).toMatchObject({
      model: "gemini-mock-flash",
      outcome: "VALIDATION_ERROR",
      httpStatus: 200,
      errorCode: "INCOMPLETE_RESPONSE",
      errorMessage: "finishReason=MAX_TOKENS; text=EMPTY",
      inputTokens: 1,
      outputTokens: 1,
    });
  });

  it("models.get 자체가 404면 GEMINI_MODEL_NOT_FOUND (생성 요청 없음)", async () => {
    const { uid, deps } = await setup("select-get404");
    await verifyGeminiConnection(uid, deps);
    const mock = createMockGeminiClient({ failGet: { "gemini-mock-pro": "MODEL_NOT_FOUND" } });
    await expect(selectGeminiModel(uid, "gemini-mock-pro", { ...deps, client: mock.client })).rejects.toMatchObject({ code: "GEMINI_MODEL_NOT_FOUND" });
    expect(mock.calls.map((c) => c.operation)).toEqual(["models.get"]);
  });

  it("생성 요청이 할당량 초과면 429이고 모델을 바꾸지 않으며 연결은 ACTIVE 유지", async () => {
    const { uid, deps } = await setup("select-quota");
    await verifyGeminiConnection(uid, deps);
    const quota = createMockGeminiClient({ failProbe: { "gemini-mock-pro": "QUOTA_EXCEEDED" } });
    const error = await selectGeminiModel(uid, "gemini-mock-pro", { ...deps, client: quota.client }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 429, code: "GEMINI_QUOTA_EXCEEDED" });
    // 일시적 초과인지 할당량 부재인지 단정하지 않고, 재시도·다른 모델 선택을 안내한다
    expect((error as Error).message).toMatch(/나중에 다시 시도하거나 다른 모델을 선택/);
    expect(await row(uid)).toMatchObject({ defaultModel: null, status: "ACTIVE" });
  });

  it("모델 확인 중 키가 무효로 판정되면 연결을 INVALID로 바꾼다", async () => {
    const { uid, apiKey, deps } = await setup("select-keyinvalid");
    await verifyGeminiConnection(uid, deps);
    const revoked = createMockGeminiClient({ failKeys: { [apiKey]: "KEY_INVALID" } });
    await expect(selectGeminiModel(uid, "gemini-mock-flash", { ...deps, client: revoked.client })).rejects.toMatchObject({ code: "GEMINI_KEY_INVALID" });
    expect((await row(uid)).status).toBe("INVALID");
  });
});

describe("키 원문 전달 (형식 보정 없음)", () => {
  const variants = [
    ["AQ", "Ab8FakeNewFormatKey_for-test"].join("."),
    "sk-arbitrary-prefix",
    "  spaces-around  ",
    "key/with+odd=chars",
    "유니코드키-테스트",
  ];
  for (const apiKey of variants) {
    it(`저장 → 복호화 → 검증 호출까지 그대로 전달된다: ${JSON.stringify(apiKey)}`, async () => {
      const user = await createTestUser("variant");
      const uid = asAuthenticatedUserId(user.id);
      await saveGeminiApiKey(uid, apiKey, material);
      const mock = createMockGeminiClient();
      await verifyGeminiConnection(uid, { client: mock.client, material });
      expect(mock.receivedKeys).toEqual([apiKey]);
      expect((await row(user.id)).keyLast4).toBe(apiKey.slice(-4));
    });
  }
});

describe("모델 사용 관문 (requireUsableGeminiConnection)", () => {
  it("연결 없음·미검증·모델 미선택은 모두 차단, 외부 호출 없음", async () => {
    const none = await createTestUser("gate-none");
    await expect(requireUsableGeminiConnection(asAuthenticatedUserId(none.id))).rejects.toMatchObject({ code: "GEMINI_NOT_CONNECTED" });

    const { uid, deps, mock } = await setup("gate");
    await expect(requireUsableGeminiConnection(uid)).rejects.toMatchObject({ code: "GEMINI_NOT_VERIFIED" });
    await verifyGeminiConnection(uid, deps);
    await expect(requireUsableGeminiConnection(uid)).rejects.toMatchObject({ code: "GEMINI_MODEL_NOT_SELECTED" });
    const callsBefore = mock.calls.length;
    await selectGeminiModel(uid, "gemini-mock-flash", deps);
    await expect(requireUsableGeminiConnection(uid)).resolves.toMatchObject({ modelId: "gemini-mock-flash" });
    expect(mock.calls.length - callsBefore).toBe(2);
  });
});

describe("중복 요청·호출 한도", () => {
  it("같은 연결의 동시 검증 5건은 외부 호출 1회로 합쳐진다", async () => {
    const { user, uid, deps, mock } = await setup("dedupe", { delayMs: 80 });
    const results = await Promise.all(Array.from({ length: 5 }, () => verifyGeminiConnection(uid, deps)));
    expect(mock.calls).toHaveLength(1);
    expect(results.every((r) => r.verification.ok)).toBe(true);
    expect(await logs(user.id)).toHaveLength(1);
  });

  it(`사용자당 ${PROVIDER_CHECK_RATE_LIMIT.maxCalls}회/${PROVIDER_CHECK_RATE_LIMIT.windowMs / 60000}분을 넘으면 429이고 외부 호출하지 않는다`, async () => {
    const { uid, deps, mock } = await setup("ratelimit");
    for (let i = 0; i < PROVIDER_CHECK_RATE_LIMIT.maxCalls; i++) await verifyGeminiConnection(uid, deps);
    expect(mock.calls).toHaveLength(PROVIDER_CHECK_RATE_LIMIT.maxCalls);

    const error = await verifyGeminiConnection(uid, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect((error as ProviderRateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    expect(mock.calls).toHaveLength(PROVIDER_CHECK_RATE_LIMIT.maxCalls);

    // 모델 선택(2회 필요)도 같은 한도를 쓴다
    await expect(listGeminiModels(uid, deps)).rejects.toBeInstanceOf(ProviderRateLimitError);
    await expect(selectGeminiModel(uid, "gemini-mock-flash", deps)).rejects.toBeInstanceOf(ProviderRateLimitError);

    // 창이 지나면 다시 허용
    const later = () => new Date(Date.now() + PROVIDER_CHECK_RATE_LIMIT.windowMs + 1000);
    await expect(verifyGeminiConnection(uid, { ...deps, now: later })).resolves.toMatchObject({ verification: { ok: true } });
  });

  it("호출 기록에 API 키가 담기지 않는다", async () => {
    const { user, uid, apiKey, deps } = await setup("logsafe");
    await verifyGeminiConnection(uid, deps);
    await selectGeminiModel(uid, "gemini-mock-flash", deps);
    expect(JSON.stringify(await logs(user.id))).not.toContain(apiKey);
  });
});

describe("사용자 간 격리", () => {
  it("다른 사용자는 내 연결로 검증·목록·모델 선택을 할 수 없다", async () => {
    const a = await setup("iso-a");
    await verifyGeminiConnection(a.uid, a.deps);
    const b = await createTestUser("iso-b");
    const bid = asAuthenticatedUserId(b.id);
    const mock = createMockGeminiClient();

    await expect(verifyGeminiConnection(bid, { client: mock.client, material })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listGeminiModels(bid, { client: mock.client, material })).rejects.toBeInstanceOf(NotFoundError);
    await expect(selectGeminiModel(bid, "gemini-mock-flash", { client: mock.client, material })).rejects.toBeInstanceOf(NotFoundError);
    expect(mock.calls).toHaveLength(0);
    expect((await row(a.user.id)).defaultModel).toBeNull();
  });
});
