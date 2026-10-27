import { z } from "zod";
import { WORLD_NAME_MAX_LENGTH } from "../../../config/limits";

// 세계관 생성·수정 요청 스키마 (클라이언트·서버 공용, PRD FR-03).
// worldContext는 글자 수 제한이 없다. 전송 한도(10MB)는 Route Handler가 본문 크기로 검사한다.

export const WORLD_NAME_MESSAGE = `세계관 이름은 1~${WORLD_NAME_MAX_LENGTH}자로 입력하세요.`;

export const worldInputSchema = z
  .object({
    name: z
      .string({ error: WORLD_NAME_MESSAGE })
      .trim()
      .refine((v) => v.length > 0 && [...v].length <= WORLD_NAME_MAX_LENGTH, { error: WORLD_NAME_MESSAGE }),
    worldContext: z.string({ error: "세계관 컨텍스트 형식이 올바르지 않습니다." }),
  })
  .strip(); // ownerId 등 다른 필드는 버린다 (소유자는 세션에서만 정한다)

export type WorldInput = z.infer<typeof worldInputSchema>;
