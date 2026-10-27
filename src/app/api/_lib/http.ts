import { unstable_rethrow } from "next/navigation";
import { AuthConfigError } from "@/server/auth/env";
import { CryptoConfigError, DecryptionError } from "@/server/crypto/provider-key-crypto";
import { MAX_REQUEST_BODY_BYTES } from "../../../../config/limits";
import { AppError, PayloadTooLargeError } from "@/server/domain/errors";
import { logServerError } from "@/server/logging/log";

// Route Handler 공통 응답. 모든 API 응답은 캐시하지 않는다.

const NO_STORE = { "Cache-Control": "no-store" };

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** 알려진 오류는 상태 코드로, 나머지는 500. 응답·로그에 비밀 값이나 내부 메시지를 담지 않는다. */
export function errorResponse(scope: string, error: unknown): Response {
  // Next.js 내부 제어 예외(요청 시점 API 접근 시 프리렌더 중단 등)는 삼키지 않는다
  unstable_rethrow(error);
  if (error instanceof AppError) {
    const res = jsonResponse(errorBody(error.code, error.message), error.status);
    if ("retryAfterSeconds" in error && typeof error.retryAfterSeconds === "number") {
      res.headers.set("Retry-After", String(error.retryAfterSeconds));
    }
    return res;
  }
  if (error instanceof AuthConfigError || error instanceof CryptoConfigError) {
    console.error(`[${scope}] ${error.message}`); // 변수 이름만 포함
    return jsonResponse(errorBody("SERVER_NOT_CONFIGURED", "서버 설정이 완료되지 않았습니다."), 500);
  }
  if (error instanceof DecryptionError) {
    logServerError(scope, error);
    return jsonResponse(errorBody("KEY_UNREADABLE", "저장된 API 키를 읽을 수 없습니다. 키를 다시 등록하세요."), 500);
  }
  logServerError(scope, error);
  return jsonResponse(errorBody("INTERNAL_ERROR", "요청을 처리하지 못했습니다."), 500);
}

/**
 * 크기 제한이 있는 JSON 본문 파싱. 한도를 넘으면 PayloadTooLargeError(413), 형식 오류는 undefined.
 * Content-Length를 먼저 보고, 없거나 거짓이어도 스트림을 읽으며 누적 바이트로 다시 끊는다.
 */
export async function readJsonWithLimit(request: Request, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError();
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** JSON 본문 파싱. 형식 오류는 400. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
