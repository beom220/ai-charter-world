import { afterEach, describe, expect, it, vi } from "vitest";
import { GEMINI_PROBE_MAX_OUTPUT_TOKENS } from "../../config/limits";
import { assertNoMockProviderInProduction, MockInProductionError } from "@/server/llm";
import { createGeminiSdkClient, GeminiCallError, type GeminiCallRecord, type GeminiModelInfo } from "@/server/llm/gemini/client";
import { isSelectableGeminiModel, selectableModels } from "@/server/llm/gemini/models";

// 실제 @google/genai SDK에 가짜 fetch를 주입해 검증한다. 네트워크·실제 키를 쓰지 않는다.
const FAKE_KEY = ["AIza", "SyClientUnitTest00000000000000000000"].join("").slice(0, 39);

type Captured = { url: string; method: string; headers: Headers; body: string | null };

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Captured[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const apiError = (status: number, statusText: string, reason?: string, message = "error") =>
  json(
    {
      error: {
        code: status,
        message,
        status: statusText,
        ...(reason ? { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] } : {}),
      },
    },
    status,
  );

const MODELS_PAGE = {
  models: [
    { name: "models/gemini-test-flash", displayName: "Test Flash", supportedGenerationMethods: ["generateContent", "countTokens"], inputTokenLimit: 1000, outputTokenLimit: 100, thinking: true },
    { name: "models/text-embedding-test", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
  ],
};

const noop = () => {};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("키 전달·요청 형태", () => {
  it("API 키는 x-goog-api-key 헤더로만 보내고 URL에 넣지 않는다", async () => {
    const { fn, calls } = fakeFetch([json(MODELS_PAGE)]);
    await createGeminiSdkClient({ fetch: fn }).listModels(FAKE_KEY, noop);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("x-goog-api-key")).toBe(FAKE_KEY);
    expect(calls[0]!.url).not.toContain(FAKE_KEY);
    expect(new URL(calls[0]!.url).searchParams.has("key")).toBe(false);
    expect(calls[0]!.url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/.+\/models/);
  });

  it("AQ. 형식 키도 같은 헤더로 보낸다", async () => {
    const aqKey = ["AQ", "Ab8ClientUnitTestFakeKey_0123456789-abc"].join(".");
    const { fn, calls } = fakeFetch([json(MODELS_PAGE)]);
    await createGeminiSdkClient({ fetch: fn }).listModels(aqKey, noop);
    expect(calls[0]!.headers.get("x-goog-api-key")).toBe(aqKey);
    expect(calls[0]!.url).not.toContain(aqKey);
  });

  describe("환경변수 키 대체 차단 (운영자 키 사용 금지)", () => {
    const OPERATOR_KEYS = [["AIza", "SyOperatorKeyMustNeverBeUsed0000000"].join(""), ["AQ", "OperatorKeyMustNeverBeUsed_111"].join(".")];
    it("빈 키·공백만 있는 키·4096자 초과 키로는 SDK를 만들지 않고 요청하지 않는다", async () => {
      vi.stubEnv("GEMINI_API_KEY", OPERATOR_KEYS[0]!);
      vi.stubEnv("GOOGLE_API_KEY", OPERATOR_KEYS[1]!);
      const { fn, calls } = fakeFetch([json(MODELS_PAGE)]);
      const client = createGeminiSdkClient({ fetch: fn });
      const records: GeminiCallRecord[] = [];
      for (const key of ["", "   ", "\t\n", "z".repeat(4097)]) {
        await expect(client.listModels(key, (r) => records.push(r))).rejects.toMatchObject({ kind: "KEY_INVALID", local: true });
      }
      expect(calls).toHaveLength(0);
      expect(records).toHaveLength(0); // 외부 호출로 기록되지 않음
    });

    it("사용자 키가 있으면 환경변수 키가 설정돼 있어도 사용자 키만 보낸다 (접두사 무관)", async () => {
      vi.stubEnv("GEMINI_API_KEY", OPERATOR_KEYS[0]!);
      vi.stubEnv("GOOGLE_API_KEY", OPERATOR_KEYS[1]!);
      for (const userKey of [FAKE_KEY, "sk-arbitrary-user-key", ["AQ", "UserFakeKey_9"].join(".")]) {
        const { fn, calls } = fakeFetch([json(MODELS_PAGE)]);
        await createGeminiSdkClient({ fetch: fn }).listModels(userKey, noop);
        expect(calls[0]!.headers.get("x-goog-api-key")).toBe(userKey);
        for (const op of OPERATOR_KEYS) expect(JSON.stringify(calls[0])).not.toContain(op);
      }
    });
  });

  it("HTTP 헤더로 보낼 수 없는 문자가 든 키는 요청 전에 거부되고 외부 호출로 집계되지 않는다", async () => {
    // fakeFetch는 실제 fetch처럼 new Headers()에서 잘못된 헤더 값을 거부한다
    const { fn, calls } = fakeFetch([json(MODELS_PAGE)]);
    const records: GeminiCallRecord[] = [];
    const error = await createGeminiSdkClient({ fetch: fn }).listModels("line1\nline2-key", (r) => records.push(r)).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "KEY_INVALID", local: true });
    expect(calls).toHaveLength(0);
    expect(records).toMatchObject([{ sent: false, errorKind: "KEY_INVALID" }]);
    expect(JSON.stringify(error)).not.toContain("line1");
  });

  it("모델 확인(probe)은 출력 토큰 상한을 걸고 사용량을 돌려준다", async () => {
    const { fn, calls } = fakeFetch([
      json({
        candidates: [{ content: { parts: [{ text: "pong" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, thoughtsTokenCount: 5, totalTokenCount: 8 },
      }),
    ]);
    const records: GeminiCallRecord[] = [];
    const usage = await createGeminiSdkClient({ fetch: fn }).probeModel(FAKE_KEY, "gemini-test-flash", (r) => records.push(r));

    expect(usage).toEqual({ inputTokens: 2, outputTokens: 1, thoughtTokens: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("gemini-test-flash:generateContent");
    expect(JSON.parse(calls[0]!.body!).generationConfig.maxOutputTokens).toBe(GEMINI_PROBE_MAX_OUTPUT_TOKENS);
    expect(records).toMatchObject([{ operation: "models.generateContent", model: "gemini-test-flash", httpStatus: 200, errorKind: null }]);
  });
});

describe("SDK 자동 반복 요청 차단 (@google/genai 2.31.0)", () => {
  const continuing = json({
    candidates: [{ content: { parts: [{ text: "po" }], role: "model" }, continuationToken: "cont-1" }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
  });
  const final = json({
    candidates: [{ content: { parts: [{ text: "ng" }], role: "model" }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
  });

  it("대조: SDK 기본값(automatic continuation 켜짐)은 continuationToken이 오면 요청을 반복한다", async () => {
    const { GoogleGenAI } = await import("@google/genai");
    const { fn, calls } = fakeFetch([continuing, final]);
    const ai = new GoogleGenAI({ apiKey: FAKE_KEY, vertexai: false, httpOptions: { fetch: fn } });
    await ai.models.generateContent({ model: "gemini-test-flash", contents: "ping" });
    expect(calls).toHaveLength(2);
  });

  it("probe는 automaticContinuation을 꺼서 continuationToken이 와도 요청 1회로 끝난다", async () => {
    const { fn, calls } = fakeFetch([continuing, final]);
    await createGeminiSdkClient({ fetch: fn }).probeModel(FAKE_KEY, "gemini-test-flash", noop);
    expect(calls).toHaveLength(1);
  });

  for (const [label, response] of [
    ["503", apiError(503, "UNAVAILABLE")],
    ["429", apiError(429, "RESOURCE_EXHAUSTED")],
    ["500", apiError(500, "INTERNAL")],
    ["404", apiError(404, "NOT_FOUND")],
  ] as const) {
    it(`probe 실패(${label})에도 생성 요청은 1회뿐 (중복 생성 요청 없음)`, async () => {
      const { fn, calls } = fakeFetch([response, final, final]);
      await expect(createGeminiSdkClient({ fetch: fn }).probeModel(FAKE_KEY, "gemini-test-flash", noop)).rejects.toBeInstanceOf(GeminiCallError);
      expect(calls).toHaveLength(1);
    });
  }

  it("probe 네트워크 오류에도 1회뿐", async () => {
    const { fn, calls } = fakeFetch([() => Promise.reject(new TypeError("fetch failed")), final]);
    await expect(createGeminiSdkClient({ fetch: fn }).probeModel(FAKE_KEY, "gemini-test-flash", noop)).rejects.toMatchObject({ kind: "NETWORK_ERROR" });
    expect(calls).toHaveLength(1);
  });
});

describe("오류 응답에서 안전한 정보만 꺼낸다", () => {
  it("error.status·ErrorInfo.reason 토큰만 남기고 message 등 자유 문자열은 버린다", async () => {
    const leaky = json(
      {
        error: {
          code: 400,
          message: `API key not valid: ${FAKE_KEY}`,
          status: "INVALID_ARGUMENT",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", metadata: { key: FAKE_KEY } }],
        },
      },
      400,
    );
    const { fn } = fakeFetch([leaky]);
    const records: GeminiCallRecord[] = [];
    const error = await createGeminiSdkClient({ fetch: fn }).listModels(FAKE_KEY, (r) => records.push(r)).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "KEY_INVALID", upstreamDetail: "status=INVALID_ARGUMENT; reason=API_KEY_INVALID" });
    expect(records[0]!.upstreamDetail).toBe("status=INVALID_ARGUMENT; reason=API_KEY_INVALID");
    expect(JSON.stringify([error, records])).not.toContain(FAKE_KEY);
  });

  it("429 할당량 응답: quotaId·quotaMetric·quotaValue·모델·retryDelay·힌트만 남기고 프로젝트·링크·메시지는 버린다", async () => {
    const body = {
      error: {
        code: 429,
        message: `You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-test-pro. key=${FAKE_KEY}`,
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                quotaDimensions: { location: "global", model: "gemini-test-pro" },
                quotaValue: "0",
              },
            ],
          },
          { "@type": "type.googleapis.com/google.rpc.Help", links: [{ description: "Learn more", url: "https://ai.google.dev/gemini-api/docs/rate-limits" }] },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" },
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { consumer: "projects/123456789012", service: "generativelanguage.googleapis.com" } },
        ],
      },
    };
    const { fn } = fakeFetch([json(body, 429)]);
    const error = (await createGeminiSdkClient({ fetch: fn }).probeModel(FAKE_KEY, "gemini-test-pro", noop).catch((e: unknown) => e)) as GeminiCallError;

    expect(error.kind).toBe("QUOTA_EXCEEDED");
    expect(error.upstreamDetail).toBe(
      "status=RESOURCE_EXHAUSTED; reason=RATE_LIMIT_EXCEEDED; quotaId=GenerateRequestsPerDayPerProjectPerModel-FreeTier; " +
        "quotaMetric=generativelanguage.googleapis.com/generate_content_free_tier_requests; quotaValue=0; quotaModel=gemini-test-pro; " +
        "retryDelay=37s; hint=QUOTA_LIMIT_ZERO,FREE_TIER,BILLING",
    );
    for (const leaked of [FAKE_KEY, "123456789012", "projects/", "ai.google.dev", "You exceeded"]) {
      expect(error.upstreamDetail).not.toContain(leaked);
    }
  });

  it("404 응답: 신규 사용자 제한 문구는 힌트 토큰으로만 남는다", async () => {
    const body = {
      error: { code: 404, message: "This model models/gemini-test-old is no longer available to new users. Please update your code to use a newer model.", status: "NOT_FOUND" },
    };
    const { fn } = fakeFetch([json(body, 404)]);
    const error = (await createGeminiSdkClient({ fetch: fn }).probeModel(FAKE_KEY, "gemini-test-old", noop).catch((e: unknown) => e)) as GeminiCallError;
    expect(error).toMatchObject({ kind: "MODEL_NOT_FOUND", upstreamDetail: "status=NOT_FOUND; hint=MODEL_RESTRICTED_FOR_NEW_USERS" });
  });

  it("404 응답: 생성 미지원·API 버전 문구 힌트", async () => {
    const body = { error: { code: 404, message: "models/gemini-x is not found for API version v1beta, or is not supported for generateContent.", status: "NOT_FOUND" } };
    const { fn } = fakeFetch([json(body, 404)]);
    const error = (await createGeminiSdkClient({ fetch: fn }).probeModel(FAKE_KEY, "gemini-x", noop).catch((e: unknown) => e)) as GeminiCallError;
    expect(error.upstreamDetail).toBe("status=NOT_FOUND; hint=NOT_SUPPORTED_FOR_GENERATE_CONTENT,NOT_FOUND_FOR_API_VERSION");
  });

  it("형태가 다른 값(경로 주입, 비정상 지연값)은 버린다", async () => {
    const body = {
      error: {
        code: 429,
        message: "x",
        status: "RESOURCE_EXHAUSTED",
        details: [
          { violations: [{ quotaId: "id with space; injected=1", quotaMetric: "not a metric", quotaValue: "-1", quotaDimensions: { model: "../etc" } }] },
          { retryDelay: "soon" },
        ],
      },
    };
    const { fn } = fakeFetch([json(body, 429)]);
    const error = (await createGeminiSdkClient({ fetch: fn }).listModels(FAKE_KEY, noop).catch((e: unknown) => e)) as GeminiCallError;
    expect(error.upstreamDetail).toBe("status=RESOURCE_EXHAUSTED");
  });

  it("열거형 토큰이 아닌 값은 버린다", async () => {
    const odd = json({ error: { code: 404, message: "x", status: "not a token; injected=1", details: [{ reason: "lower_case" }] } }, 404);
    const { fn } = fakeFetch([odd]);
    const error = await createGeminiSdkClient({ fetch: fn }).getModel(FAKE_KEY, "gemini-x", noop).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "MODEL_NOT_FOUND", upstreamDetail: null });
  });
});

describe("모델 목록", () => {
  it("한 페이지면 HTTP 1회, 모델 정보를 정규화한다", async () => {
    const { fn, calls } = fakeFetch([json(MODELS_PAGE)]);
    const records: GeminiCallRecord[] = [];
    const models = await createGeminiSdkClient({ fetch: fn }).listModels(FAKE_KEY, (r) => records.push(r));
    expect(calls).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(models[0]).toEqual({
      id: "gemini-test-flash",
      displayName: "Test Flash",
      description: null,
      inputTokenLimit: 1000,
      outputTokenLimit: 100,
      supportedActions: ["generateContent", "countTokens"],
      thinking: true,
    });
  });

  it("다음 페이지가 있으면 이어서 조회하되 최대 3페이지까지만", async () => {
    const page = (n: number) => json({ models: [{ name: `models/gemini-p${n}`, supportedGenerationMethods: ["generateContent"] }], nextPageToken: `t${n}` });
    const { fn, calls } = fakeFetch([page(1), page(2), page(3), page(4)]);
    const models = await createGeminiSdkClient({ fetch: fn }).listModels(FAKE_KEY, noop);
    expect(calls).toHaveLength(3);
    expect(models.map((m) => m.id)).toEqual(["gemini-p1", "gemini-p2", "gemini-p3"]);
  });
});

describe("오류 분류 — 자동 재시도 없음", () => {
  const cases: [string, () => Response, string][] = [
    ["400 API_KEY_INVALID", apiError(400, "INVALID_ARGUMENT", "API_KEY_INVALID", "API key not valid. Please pass a valid API key."), "KEY_INVALID"],
    ["401", apiError(401, "UNAUTHENTICATED"), "KEY_INVALID"],
    ["403 권한·지역", apiError(403, "PERMISSION_DENIED"), "PERMISSION_DENIED"],
    ["429 할당량", apiError(429, "RESOURCE_EXHAUSTED"), "QUOTA_EXCEEDED"],
    ["500", apiError(500, "INTERNAL"), "UPSTREAM_ERROR"],
    ["503", apiError(503, "UNAVAILABLE"), "UPSTREAM_ERROR"],
    ["504", apiError(504, "DEADLINE_EXCEEDED"), "TIMEOUT"],
    ["다른 400", apiError(400, "INVALID_ARGUMENT", undefined, "bad"), "BAD_REQUEST"],
  ];

  for (const [label, response, kind] of cases) {
    it(`${label} → ${kind}, HTTP 요청은 1회뿐`, async () => {
      const { fn, calls } = fakeFetch([response, json(MODELS_PAGE)]);
      const records: GeminiCallRecord[] = [];
      const error = await createGeminiSdkClient({ fetch: fn }).listModels(FAKE_KEY, (r) => records.push(r)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GeminiCallError);
      expect((error as GeminiCallError).kind).toBe(kind);
      expect(calls).toHaveLength(1);
      expect(records).toMatchObject([{ errorKind: kind }]);
      // 오류 객체에 키·응답 본문이 담기지 않는다
      expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
      expect((error as Error).message).toBe(`Gemini 호출 실패: ${kind}`);
    });
  }

  it("모델 조회 404 → MODEL_NOT_FOUND", async () => {
    const { fn } = fakeFetch([apiError(404, "NOT_FOUND")]);
    await expect(createGeminiSdkClient({ fetch: fn }).getModel(FAKE_KEY, "gemini-missing", noop)).rejects.toMatchObject({ kind: "MODEL_NOT_FOUND", httpStatus: 404 });
  });

  it("네트워크 오류 → NETWORK_ERROR, 중단·시간 초과 → TIMEOUT (HTTP 상태 없음)", async () => {
    const network = fakeFetch([() => Promise.reject(new TypeError("fetch failed"))]);
    await expect(createGeminiSdkClient({ fetch: network.fn }).listModels(FAKE_KEY, noop)).rejects.toMatchObject({ kind: "NETWORK_ERROR", httpStatus: null });
    expect(network.calls).toHaveLength(1);

    const timeout = fakeFetch([() => Promise.reject(new DOMException("The operation was aborted", "AbortError"))]);
    await expect(createGeminiSdkClient({ fetch: timeout.fn }).listModels(FAKE_KEY, noop)).rejects.toMatchObject({ kind: "TIMEOUT", httpStatus: null });
    expect(timeout.calls).toHaveLength(1);
  });
});

describe("선택 가능 모델 정책", () => {
  const model = (id: string, actions = ["generateContent"]): GeminiModelInfo => ({
    id,
    displayName: id,
    description: null,
    inputTokenLimit: null,
    outputTokenLimit: null,
    supportedActions: actions,
    thinking: false,
  });

  it("generateContent 지원 + gemini- 계열 + 특수 목적 변형 제외", () => {
    expect(isSelectableGeminiModel(model("gemini-x-flash"))).toBe(true);
    expect(isSelectableGeminiModel(model("gemini-x-flash", ["embedContent"]))).toBe(false);
    expect(isSelectableGeminiModel(model("gemma-x"))).toBe(false);
    for (const id of ["gemini-x-flash-tts", "gemini-x-flash-image", "gemini-x-live", "gemini-x-native-audio-preview", "gemini-embedding-x"]) {
      expect(isSelectableGeminiModel(model(id)), id).toBe(false);
    }
  });

  it("정식 모델을 먼저, 미리보기는 뒤에 표시한다", () => {
    const sorted = selectableModels([model("gemini-b-preview-01"), model("gemini-a"), model("gemini-c-exp"), model("gemini-b")]);
    expect(sorted.map((m) => [m.id, m.preview])).toEqual([
      ["gemini-a", false],
      ["gemini-b", false],
      ["gemini-b-preview-01", true],
      ["gemini-c-exp", true],
    ]);
  });
});

describe("MockProvider 프로덕션 차단", () => {
  it("NODE_ENV=production + LLM_PROVIDER=mock이면 실패한다", () => {
    expect(() => assertNoMockProviderInProduction({ NODE_ENV: "production", LLM_PROVIDER: "mock" })).toThrow(MockInProductionError);
    expect(() => assertNoMockProviderInProduction({ NODE_ENV: "development", LLM_PROVIDER: "mock" })).not.toThrow();
    expect(() => assertNoMockProviderInProduction({ NODE_ENV: "production" })).not.toThrow();
  });
});
