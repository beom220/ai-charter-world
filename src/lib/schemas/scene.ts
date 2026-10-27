import { z } from "zod";
import { SCENE_PARTICIPANTS_MAX, SCENE_PARTICIPANTS_MIN } from "../../../config/limits";

// 대화 장면 생성 요청 (클라이언트·서버 공용, Phase 5-1).

export const SCENE_PARTICIPANTS_MESSAGE = `대화할 캐릭터를 ${SCENE_PARTICIPANTS_MIN}~${SCENE_PARTICIPANTS_MAX}명 선택하세요.`;

export const sceneGenerateInputSchema = z
  .object({
    characterIds: z
      .array(z.string().min(1).max(64), { error: SCENE_PARTICIPANTS_MESSAGE })
      .min(SCENE_PARTICIPANTS_MIN, { error: SCENE_PARTICIPANTS_MESSAGE })
      .max(SCENE_PARTICIPANTS_MAX, { error: SCENE_PARTICIPANTS_MESSAGE })
      .refine((ids) => new Set(ids).size === ids.length, { error: "같은 캐릭터를 두 번 선택할 수 없습니다." }),
  })
  .strip();
