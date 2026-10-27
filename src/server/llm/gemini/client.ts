import { ApiError, GoogleGenAI, type Model } from "@google/genai";
import { isAcceptableGeminiApiKey } from "@/lib/schemas/provider";
import {
  GEMINI_METADATA_TIMEOUT_MS,
  GEMINI_MODEL_LIST_MAX_PAGES,
  GEMINI_MODEL_LIST_PAGE_SIZE,
  GEMINI_PROBE_MAX_OUTPUT_TOKENS,
  GEMINI_PROBE_TIMEOUT_MS,
} from "../../../../config/limits";

// Gemini 연결 확인용 최소 클라이언트 (architecture.md §8.2). 런타임 독립 — Next.js에 의존하지 않는다.
// - 사용자 키만 쓴다. 빈 키로는 만들지 않는다 (SDK가 GOOGLE_API_KEY/GEMINI_API_KEY 환경변수로 대체하는 것을 막음)
// - 키는 SDK가 x-goog-api-key 헤더로 보낸다 (URL 쿼리스트링에 넣지 않음)
// - 자동 반복 요청 없음 (@google/genai 2.31.0 조사 결과):
//   · httpOptions.retryOptions를 지정하지 않으면 SDK는 HTTP 요청을 1회만 보낸다
//   · generateContent는 automatic continuation이 기본으로 켜져 있어 응답에 continuationToken이 있으면 요청을 반복한다
//     → probe에서 automaticContinuation: false로 끈다
//   · 자동 함수 호출(AFC)은 도구가 있을 때만 반복한다 → 도구를 쓰지 않고 disable: true로 명시한다
// - 오류는 종류(kind)로만 분류하고, SDK 오류 메시지(응답 본문)는 밖으로 내보내지 않는다

export type GeminiModelInfo = {
  /** SDK·API에 넘기는 모델 ID (예: "models/" 접두사를 뗀 값) */
  id: string;
  displayName: string;
  description: string | null;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  supportedActions: string[];
  thinking: boolean;
};

export type GeminiUsage = { inputTokens: number | null; outputTokens: number | null; thoughtTokens: number | null };

/** 외부 호출 1건의 결과. 호출 기록(ApiRequestLog)에 쓴다. */
export type GeminiCallRecord = {
  operation: "models.list" | "models.get" | "models.generateContent";
  model: string | null;
  startedAt: Date;
  latencyMs: number;
  httpStatus: number | null;
  errorKind: GeminiErrorKind | null;
  /** Google 오류 응답에서 꺼낸 안전한 열거형 토큰만 (예: "status=NOT_FOUND; reason=API_KEY_INVALID") */
  upstreamDetail: string | null;
  usage: GeminiUsage | null;
  /** 요청이 실제로 Gemini로 나갔는지. 로컬에서 거부된 시도(전송 불가 키)는 false — 외부 호출로 집계하지 않는다 */
  sent: boolean;
};

export type GeminiErrorKind =
  | "KEY_INVALID"
  | "PERMISSION_DENIED"
  | "QUOTA_EXCEEDED"
  | "MODEL_NOT_FOUND"
  | "BAD_REQUEST"
  | "UPSTREAM_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR";

export class GeminiCallError extends Error {
  constructor(
    readonly kind: GeminiErrorKind,
    readonly httpStatus: number | null,
    readonly upstreamDetail: string | null = null,
    /** 요청 전에 로컬에서 거부됨 (외부 호출 아님) */
    readonly local = false,
  ) {
    super(`Gemini 호출 실패: ${kind}`);
    this.name = "GeminiCallError";
  }
}

/** 키를 받는 쪽(서비스)이 한 번의 사용 동안만 키를 쥐도록, 키는 메서드 인자로만 받는다. */
export interface GeminiKeyClient {
  listModels(apiKey: string, onCall: (record: GeminiCallRecord) => void): Promise<GeminiModelInfo[]>;
  getModel(apiKey: string, modelId: string, onCall: (record: GeminiCallRecord) => void): Promise<GeminiModelInfo>;
  /** 최소 생성 요청으로 실제 사용 가능 여부를 확인한다 (출력 토큰 상한 GEMINI_PROBE_MAX_OUTPUT_TOKENS) */
  probeModel(apiKey: string, modelId: string, onCall: (record: GeminiCallRecord) => void): Promise<GeminiUsage>;
}

function errorText(error: ApiError): string {
  return error.message ?? "";
}

// ── 진단용 안전 필드 (허용 목록) ─────────────────────────────
// Google 오류 본문에서 원인 진단에 필요한 구조화 필드만 꺼낸다. 각 값은 정해진 형태일 때만 쓴다.
// 버리는 것: error.message 원문, ErrorInfo.metadata(프로젝트 번호 등), Help 링크, 그 밖의 모든 필드.
// message는 저장하지 않고, 알려진 문구가 있는지만 검사해 고정 토큰(hint)으로 바꾼다.

const ENUM_TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/; // status, reason
const QUOTA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/; // 예: GenerateRequestsPerDayPerProjectPerModel-FreeTier
const QUOTA_METRIC = /^[a-z0-9.-]+\/[a-z0-9_/-]{1,127}$/; // 예: generativelanguage.googleapis.com/generate_content_free_tier_requests
const QUOTA_VALUE = /^\d{1,12}$/;
const RETRY_DELAY = /^\d{1,6}(?:\.\d{1,9})?s$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,99}$/;

/** 메시지에서 감지할 알려진 문구 → 고정 토큰. 메시지 자체는 저장하지 않는다 */
const MESSAGE_HINTS: [RegExp, string][] = [
  [/no longer available to new users|available to users who have (?:actively )?used/i, "MODEL_RESTRICTED_FOR_NEW_USERS"],
  [/not supported for generateContent/i, "NOT_SUPPORTED_FOR_GENERATE_CONTENT"],
  [/is not found for API version/i, "NOT_FOUND_FOR_API_VERSION"],
  [/\blimit:\s*0\b/i, "QUOTA_LIMIT_ZERO"],
  [/free[ _]tier/i, "FREE_TIER"],
  [/billing/i, "BILLING"],
];

type ErrorDetail = {
  "@type"?: unknown;
  reason?: unknown;
  violations?: { quotaId?: unknown; quotaMetric?: unknown; quotaValue?: unknown; quotaDimensions?: { model?: unknown } }[];
  retryDelay?: unknown;
};

const pick = (value: unknown, pattern: RegExp) => (typeof value === "string" && pattern.test(value) ? value : null);

/**
 * 예: "status=RESOURCE_EXHAUSTED; quotaId=GenerateRequestsPerDayPerProjectPerModel-FreeTier; quotaValue=0; quotaModel=gemini-x; retryDelay=37s; hint=QUOTA_LIMIT_ZERO,FREE_TIER"
 * ApiRequestLog.errorMessage(500자)에 저장한다. 클라이언트로는 보내지 않는다.
 */
export function safeUpstreamDetail(error: ApiError): string | null {
  const text = errorText(error);
  const start = text.indexOf("{");
  if (start < 0) return null;
  let body: { error?: { status?: unknown; message?: unknown; details?: ErrorDetail[] } };
  try {
    body = JSON.parse(text.slice(start));
  } catch {
    return null;
  }
  const err = body.error;
  if (!err) return null;
  const details = Array.isArray(err.details) ? err.details : [];
  const parts: string[] = [];
  const add = (name: string, value: string | null) => value !== null && parts.push(`${name}=${value}`);

  add("status", pick(err.status, ENUM_TOKEN));
  add("reason", pick(details.find((d) => typeof d?.reason === "string")?.reason, ENUM_TOKEN));
  const violation = details.flatMap((d) => (Array.isArray(d?.violations) ? d.violations : []))[0];
  if (violation) {
    add("quotaId", pick(violation.quotaId, QUOTA_ID));
    add("quotaMetric", pick(violation.quotaMetric, QUOTA_METRIC));
    add("quotaValue", pick(violation.quotaValue, QUOTA_VALUE));
    add("quotaModel", pick(violation.quotaDimensions?.model, MODEL_ID));
  }
  add("retryDelay", pick(details.find((d) => typeof d?.retryDelay === "string")?.retryDelay, RETRY_DELAY));
  if (typeof err.message === "string") {
    const hints = MESSAGE_HINTS.filter(([re]) => re.test(err.message as string)).map(([, token]) => token);
    if (hints.length > 0) parts.push(`hint=${hints.join(",")}`);
  }
  return parts.length > 0 ? parts.join("; ").slice(0, 500) : null;
}

/** SDK·네트워크 오류를 종류로 분류한다. 메시지는 분류에만 쓰고 저장·로그하지 않는다. */
export function classifyGeminiError(error: unknown): GeminiCallError {
  if (error instanceof GeminiCallError) return error;
  if (error instanceof ApiError) {
    const status = error.status;
    const detail = safeUpstreamDetail(error);
    const make = (kind: GeminiErrorKind) => new GeminiCallError(kind, status, detail);
    if (status === 400 && /API_KEY_INVALID|API key not valid|API_KEY_EXPIRED/i.test(errorText(error))) return make("KEY_INVALID");
    if (status === 401) return make("KEY_INVALID");
    if (status === 403) return make("PERMISSION_DENIED");
    if (status === 404) return make("MODEL_NOT_FOUND");
    if (status === 429) return make("QUOTA_EXCEEDED");
    if (status === 408 || status === 504) return make("TIMEOUT");
    if (status >= 500) return make("UPSTREAM_ERROR");
    return make("BAD_REQUEST");
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") return new GeminiCallError("TIMEOUT", null);
  // 키에 HTTP 헤더로 보낼 수 없는 문자(줄바꿈 등)가 있으면 fetch가 요청 전에 TypeError를 던진다.
  // 이런 키는 Gemini가 받을 수 없으므로 키 오류로 본다 (메시지는 분류에만 쓰고 저장하지 않음 — 키가 담길 수 있음)
  if (error instanceof TypeError && /header/i.test(error.message)) return new GeminiCallError("KEY_INVALID", null, "local=HEADER_VALUE_REJECTED", true);
  return new GeminiCallError("NETWORK_ERROR", null);
}

export function toModelInfo(model: Model): GeminiModelInfo | null {
  if (!model.name) return null;
  return {
    id: model.name.replace(/^models\//, ""),
    displayName: model.displayName ?? model.name,
    description: model.description ?? null,
    inputTokenLimit: model.inputTokenLimit ?? null,
    outputTokenLimit: model.outputTokenLimit ?? null,
    supportedActions: model.supportedActions ?? [],
    thinking: model.thinking ?? false,
  };
}

type SdkOptions = { fetch?: typeof fetch; baseUrl?: string };

export function createGeminiSdkClient(options: SdkOptions = {}): GeminiKeyClient {
  const sdk = (apiKey: string, timeout: number) => {
    // 빈 키를 넘기면 SDK가 GOOGLE_API_KEY/GEMINI_API_KEY 환경변수로 대체한다 → 요청 스키마와 같은 검사로 막는다
    if (!isAcceptableGeminiApiKey(apiKey)) throw new GeminiCallError("KEY_INVALID", null, "local=EMPTY_OR_TOO_LONG", true);
    return new GoogleGenAI({
      apiKey,
      vertexai: false,
      httpOptions: { timeout, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) },
    });
  };

  async function call<T>(
    record: Pick<GeminiCallRecord, "operation" | "model">,
    onCall: (r: GeminiCallRecord) => void,
    run: () => Promise<{ value: T; usage?: GeminiUsage }>,
  ): Promise<T> {
    const startedAt = new Date();
    const t0 = performance.now();
    try {
      const { value, usage } = await run();
      onCall({ ...record, startedAt, latencyMs: Math.round(performance.now() - t0), httpStatus: 200, errorKind: null, upstreamDetail: null, usage: usage ?? null, sent: true });
      return value;
    } catch (error) {
      const classified = classifyGeminiError(error);
      onCall({
        ...record,
        startedAt,
        latencyMs: Math.round(performance.now() - t0),
        httpStatus: classified.httpStatus,
        errorKind: classified.kind,
        upstreamDetail: classified.upstreamDetail,
        usage: null,
        sent: !classified.local,
      });
      throw classified;
    }
  }

  return {
    async listModels(apiKey, onCall) {
      const ai = sdk(apiKey, GEMINI_METADATA_TIMEOUT_MS);
      const models: GeminiModelInfo[] = [];
      // 페이지마다 HTTP 요청 1건. 첫 페이지는 list(), 다음 페이지는 nextPage()
      const pager = await call({ operation: "models.list", model: null }, onCall, async () => ({
        value: await ai.models.list({ config: { pageSize: GEMINI_MODEL_LIST_PAGE_SIZE } }),
      }));
      for (let page = 1; ; page++) {
        for (const m of pager.page) {
          const info = toModelInfo(m);
          if (info) models.push(info);
        }
        if (!pager.hasNextPage() || page >= GEMINI_MODEL_LIST_MAX_PAGES) break;
        const current = pager;
        await call({ operation: "models.list", model: null }, onCall, async () => ({ value: await current.nextPage() }));
      }
      return models;
    },

    async getModel(apiKey, modelId, onCall) {
      const ai = sdk(apiKey, GEMINI_METADATA_TIMEOUT_MS);
      const model = await call({ operation: "models.get", model: modelId }, onCall, async () => ({
        value: await ai.models.get({ model: modelId }),
      }));
      const info = toModelInfo(model);
      if (!info) throw new GeminiCallError("MODEL_NOT_FOUND", null);
      return info;
    },

    async probeModel(apiKey, modelId, onCall) {
      const ai = sdk(apiKey, GEMINI_PROBE_TIMEOUT_MS);
      return call({ operation: "models.generateContent", model: modelId }, onCall, async () => {
        const res = await ai.models.generateContent({
          model: modelId,
          contents: "ping",
          config: {
            maxOutputTokens: GEMINI_PROBE_MAX_OUTPUT_TOKENS,
            candidateCount: 1,
            automaticContinuation: false, // SDK 기본값(true)이면 continuationToken마다 요청을 반복한다
            automaticFunctionCalling: { disable: true },
          },
        });
        const usage: GeminiUsage = {
          inputTokens: res.usageMetadata?.promptTokenCount ?? null,
          outputTokens: res.usageMetadata?.candidatesTokenCount ?? null,
          thoughtTokens: res.usageMetadata?.thoughtsTokenCount ?? null,
        };
        return { value: usage, usage };
      });
    },
  };
}
