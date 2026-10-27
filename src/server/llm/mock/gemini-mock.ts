import type { GeminiCallRecord, GeminiKeyClient, GeminiModelInfo, GeminiUsage } from "../gemini/client";
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
    onCall: (r: GeminiCallRecord) => void,
    extraFail: GeminiErrorKind | undefined,
    value: () => T,
    usage: GeminiUsage | null = null,
  ): Promise<T> {
    const startedAt = new Date();
    receivedKeys.push(apiKey);
    if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
    const kind = script.failKeys?.[apiKey] ?? extraFail;
    const record: GeminiCallRecord = {
      ...base,
      startedAt,
      latencyMs: script.delayMs ?? 0,
      httpStatus: kind ? HTTP_STATUS[kind] : 200,
      errorKind: kind ?? null,
      upstreamDetail: kind ? (UPSTREAM_DETAIL[kind] ?? null) : null,
      // 응답을 받은 뒤 실패로 판정된 경우(INCOMPLETE_RESPONSE)는 토큰이 쓰였으므로 사용량을 남긴다
      usage: kind && kind !== "INCOMPLETE_RESPONSE" ? null : usage,
      sent: true,
    };
    calls.push(record);
    onCall(record);
    if (kind) throw new GeminiCallError(kind, HTTP_STATUS[kind], record.upstreamDetail, false, record.usage);
    return value();
  }

  const client: GeminiKeyClient = {
    listModels: (apiKey, onCall) => run({ operation: "models.list", model: null }, apiKey, onCall, undefined, () => models),
    getModel: (apiKey, modelId, onCall) =>
      run({ operation: "models.get", model: modelId }, apiKey, onCall, script.failGet?.[modelId] ?? (models.some((m) => m.id === modelId) ? undefined : "MODEL_NOT_FOUND"), () => models.find((m) => m.id === modelId)!),
    probeModel: (apiKey, modelId, onCall) => {
      const usage = { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 };
      return run({ operation: "models.generateContent", model: modelId }, apiKey, onCall, script.failProbe?.[modelId], () => usage, usage);
    },
  };
  return { client, calls, receivedKeys };
}
