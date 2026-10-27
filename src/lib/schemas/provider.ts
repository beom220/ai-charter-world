import { z } from "zod";

// Provider 연결 요청 스키마 (클라이언트·서버 공용).
// 오류 메시지에 입력값(키)을 담지 않는다.

/** Google API 키 형식: "AIza" + 35자 (영숫자, -, _) */
const GEMINI_API_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{35}$/;

export const GEMINI_API_KEY_FORMAT_MESSAGE = "Gemini API 키 형식이 올바르지 않습니다. Google AI Studio에서 발급한 키(AIza로 시작하는 39자)를 입력하세요.";

export const geminiApiKeyInputSchema = z
  .object({
    apiKey: z.string({ error: GEMINI_API_KEY_FORMAT_MESSAGE }).trim().regex(GEMINI_API_KEY_PATTERN, { error: GEMINI_API_KEY_FORMAT_MESSAGE }),
  })
  .strip(); // userId 등 다른 필드는 버린다 (사용자 ID는 세션에서만 얻는다)

export type GeminiApiKeyInput = z.infer<typeof geminiApiKeyInputSchema>;
