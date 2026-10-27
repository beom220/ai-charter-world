import { AuthConfigError } from "@/server/auth/env";
import { CryptoConfigError, DecryptionError } from "@/server/crypto/provider-key-crypto";
import { AppError } from "@/server/domain/errors";
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
  if (error instanceof AppError) return jsonResponse(errorBody(error.code, error.message), error.status);
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

/** JSON 본문 파싱. 형식 오류는 400. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
