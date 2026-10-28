import { z } from "zod";
import { SAVE_NAME_MAX_LENGTH } from "../../../config/limits";

// 수동 저장 이름 (클라이언트·서버 공용, Phase 6)

export const SAVE_NAME_MESSAGE = `저장 이름은 1~${SAVE_NAME_MAX_LENGTH}자로 입력하세요.`;

export const saveNameSchema = z
  .object({
    name: z
      .string({ error: SAVE_NAME_MESSAGE })
      .trim()
      .refine((v) => v.length > 0 && [...v].length <= SAVE_NAME_MAX_LENGTH, { error: SAVE_NAME_MESSAGE }),
  })
  .strip();
