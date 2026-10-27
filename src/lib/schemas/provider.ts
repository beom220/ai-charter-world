import { z } from "zod";

// Provider 연결 요청 스키마 (클라이언트·서버 공용).
// 오류 메시지에 입력값(키)을 담지 않는다.

/**
 * Gemini API 키 입력 정책 (Phase 3-2 확정).
 * Google이 발급하는 키 형식은 앱이 정의하지 않는다: 접두사(AIza, AQ. 등)·길이·문자 집합을 검사하지 않고,
 * 값을 trim하거나 고치지 않는다. 비어 있거나 공백만 있는 입력은 거부하고, DoS 방지용 최대 길이만 둔다.
 * 실제 유효성은 Gemini API 응답(키 검증)으로 판단한다. 서버 SDK 생성 전 검사도 이 함수를 쓴다.
 */
export const GEMINI_API_KEY_MAX_LENGTH = 4096;

export function isAcceptableGeminiApiKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= GEMINI_API_KEY_MAX_LENGTH && /\S/.test(value);
}

export const GEMINI_API_KEY_FORMAT_MESSAGE = `Gemini API 키를 입력하세요. 비어 있거나 공백만 있는 값, ${GEMINI_API_KEY_MAX_LENGTH}자를 넘는 값은 받을 수 없습니다.`;

export const geminiApiKeyInputSchema = z
  .object({
    apiKey: z.string({ error: GEMINI_API_KEY_FORMAT_MESSAGE }).refine(isAcceptableGeminiApiKey, { error: GEMINI_API_KEY_FORMAT_MESSAGE }),
  })
  .strip(); // userId 등 다른 필드는 버린다 (사용자 ID는 세션에서만 얻는다)

export type GeminiApiKeyInput = z.infer<typeof geminiApiKeyInputSchema>;

export const GEMINI_MODEL_ID_MESSAGE = "모델 ID 형식이 올바르지 않습니다.";

/** 모델 선택 입력. "models/" 접두사는 떼고 저장한다. */
export const geminiModelSelectionSchema = z
  .object({
    model: z
      .string({ error: GEMINI_MODEL_ID_MESSAGE })
      .trim()
      .regex(/^(?:models\/)?[a-z0-9][a-z0-9.-]{0,99}$/, { error: GEMINI_MODEL_ID_MESSAGE })
      .transform((v) => v.replace(/^models\//, "")),
  })
  .strip();
