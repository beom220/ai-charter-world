import { GEMINI_MODEL_ID_MESSAGE, geminiModelSelectionSchema } from "@/lib/schemas/provider";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { BadRequestError } from "@/server/domain/errors";
import { selectGeminiModel } from "@/server/domain/providers/gemini-verification";
import { errorResponse, jsonResponse, readJson } from "../../../_lib/http";

// PUT /api/providers/gemini/model { model } — 기본 모델 선택 (외부 호출: models.get + 최소 generateContent).
// 200 { connection }, 400 형식 오류, 404 연결 없음, 409 미검증, 422 사용 불가 모델, 429 한도·할당량, 502·504 Gemini 오류

const SCOPE = "providers.gemini.model";

export async function PUT(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const parsed = geminiModelSelectionSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new BadRequestError(GEMINI_MODEL_ID_MESSAGE);
    return jsonResponse({ connection: await selectGeminiModel(userId, parsed.data.model) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
