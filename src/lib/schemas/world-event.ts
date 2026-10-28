import { z } from "zod";
import { USER_EVENT_TEXT_MAX_LENGTH } from "../../../config/limits";

// 사용자 지정 사건 등록 요청 (클라이언트·서버 공용, Phase 7-2-3).
// text: 세계에 일어나는 일(캐릭터 명령이 아님), 코드 포인트 200자. requestId: 클라이언트가 만든 멱등 키 (같은 요청 재전송 시 그대로).

export const USER_EVENT_TEXT_MESSAGE = `사건 내용은 1~${USER_EVENT_TEXT_MAX_LENGTH}자로 입력하세요.`;

export const userEventTextLength = (text: string) => [...text.trim()].length;

export const userEventInputSchema = z
  .object({
    text: z
      .string({ error: USER_EVENT_TEXT_MESSAGE })
      .trim()
      .refine((v) => v.length > 0 && [...v].length <= USER_EVENT_TEXT_MAX_LENGTH, { error: USER_EVENT_TEXT_MESSAGE }),
    requestId: z.string({ error: "요청 ID가 필요합니다." }).regex(/^[A-Za-z0-9_-]{8,64}$/, { error: "요청 ID 형식이 올바르지 않습니다." }),
  })
  .strip();

export type UserEventInput = z.infer<typeof userEventInputSchema>;
