import type { GeminiCallRecord, GeminiKeyClient, GeminiModelInfo, GeminiRequestMeter, GeminiUsage } from "../gemini/client";
import { GeminiCallError, type GeminiErrorKind } from "../gemini/client";

// 개발·테스트 전용 Gemini 클라이언트. 네트워크를 쓰지 않는다 (CLAUDE.md 절대 규칙 1: 프로덕션 금지).
// 모델 이름은 실제 Gemini 모델이 아닌 가짜 값이다.

export const MOCK_GEMINI_MODELS: GeminiModelInfo[] = [
  { id: "gemini-mock-flash", displayName: "Gemini Mock Flash", description: null, inputTokenLimit: 1_000_000, outputTokenLimit: 8192, supportedActions: ["generateContent", "countTokens"], thinking: true },
  { id: "gemini-mock-pro", displayName: "Gemini Mock Pro", description: null, inputTokenLimit: 1_000_000, outputTokenLimit: 8192, supportedActions: ["generateContent", "countTokens"], thinking: true },
  { id: "gemini-mock-embedding", displayName: "Gemini Mock Embedding", description: null, inputTokenLimit: 2048, outputTokenLimit: 1, supportedActions: ["embedContent"], thinking: false },
];

export type MockGeminiScript = {
  /** 키별 강제 오류 (예: 특정 키는 KEY_INVALID) */
  failKeys?: Record<string, GeminiErrorKind>;
  /** 모델별 probe 오류 */
  failProbe?: Record<string, GeminiErrorKind>;
  /** 모델별 models.get 오류 */
  failGet?: Record<string, GeminiErrorKind>;
  models?: GeminiModelInfo[];
  /** 호출 지연(ms): 동시 요청 병합 테스트용 */
  delayMs?: number;
  /** probe 결과를 호출 순서대로 지정 (null = 성공). 소진되면 failProbe·성공 규칙을 따른다 */
  probeSequence?: (GeminiErrorKind | null)[];
  /** probe 성공 응답의 사용량. null = usageMetadata 없는 응답 (기본: 입력 1·출력 1·사고 0) */
  probeUsage?: GeminiUsage | null;
  /** 429 응답의 RetryInfo.retryDelay (ms) */
  retryAfterMs?: number;
};

const HTTP_STATUS: Record<GeminiErrorKind, number | null> = {
  KEY_INVALID: 400,
  PERMISSION_DENIED: 403,
  QUOTA_EXCEEDED: 429,
  MODEL_NOT_FOUND: 404,
  BAD_REQUEST: 400,
  UPSTREAM_ERROR: 503,
  TIMEOUT: null,
  NETWORK_ERROR: null,
  INCOMPLETE_RESPONSE: 200,
};

const UPSTREAM_DETAIL: Partial<Record<GeminiErrorKind, string>> = {
  KEY_INVALID: "status=INVALID_ARGUMENT; reason=API_KEY_INVALID",
  PERMISSION_DENIED: "status=PERMISSION_DENIED",
  QUOTA_EXCEEDED: "status=RESOURCE_EXHAUSTED",
  MODEL_NOT_FOUND: "status=NOT_FOUND",
  BAD_REQUEST: "status=INVALID_ARGUMENT",
  UPSTREAM_ERROR: "status=UNAVAILABLE",
  INCOMPLETE_RESPONSE: "finishReason=MAX_TOKENS; text=EMPTY",
};

export function createMockGeminiClient(script: MockGeminiScript = {}) {
  const calls: GeminiCallRecord[] = [];
  /** 클라이언트가 받은 키 (전달 확인용, 테스트 전용) */
  const receivedKeys: string[] = [];
  const models = script.models ?? MOCK_GEMINI_MODELS;

  async function run<T>(
    base: Pick<GeminiCallRecord, "operation" | "model">,
    apiKey: string,
    meter: GeminiRequestMeter,
    extraFail: () => GeminiErrorKind | null | undefined,
    value: () => T,
    usage: GeminiUsage | null = null,
  ): Promise<T> {
    // 실제 클라이언트와 같이 예약이 거부되면 요청(= calls 기록)을 만들지 않는다
    const settle = await meter(base);
    const startedAt = new Date();
    receivedKeys.push(apiKey);
    if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
    const kind = script.failKeys?.[apiKey] ?? extraFail() ?? undefined;
    const record: GeminiCallRecord = {
      ...base,
      startedAt,
      latencyMs: script.delayMs ?? 0,
      httpStatus: kind ? HTTP_STATUS[kind] : 200,
      errorKind: kind ?? null,
      upstreamDetail: kind ? (UPSTREAM_DETAIL[kind] ?? null) : null,
      // 응답을 받은 뒤 실패로 판정된 경우(INCOMPLETE_RESPONSE)는 토큰이 쓰였으므로 사용량을 남긴다
      usage: kind && kind !== "INCOMPLETE_RESPONSE" ? null : usage,
      retryAfterMs: kind === "QUOTA_EXCEEDED" ? (script.retryAfterMs ?? null) : null,
      sent: true,
    };
    calls.push(record);
    await settle(record);
    if (kind) throw new GeminiCallError(kind, HTTP_STATUS[kind], record.upstreamDetail, false, record.usage, record.retryAfterMs);
    return value();
  }

  const sequence = [...(script.probeSequence ?? [])];

  const client: GeminiKeyClient = {
    listModels: (apiKey, meter) => run({ operation: "models.list", model: null }, apiKey, meter, () => undefined, () => models),
    getModel: (apiKey, modelId, meter) =>
      run(
        { operation: "models.get", model: modelId },
        apiKey,
        meter,
        () => script.failGet?.[modelId] ?? (models.some((m) => m.id === modelId) ? undefined : "MODEL_NOT_FOUND"),
        () => models.find((m) => m.id === modelId)!,
      ),
    probeModel: (apiKey, modelId, meter) => {
      const usage = script.probeUsage === undefined ? { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 } : script.probeUsage;
      const next = () => (sequence.length > 0 ? sequence.shift() : script.failProbe?.[modelId]);
      return run({ operation: "models.generateContent", model: modelId }, apiKey, meter, next, () => usage, usage);
    },
  };
  return { client, calls, receivedKeys };
}
