import { requireRequestUser } from "@/server/auth/request";
import { listGeminiModels } from "@/server/domain/providers/gemini-verification";
import { errorResponse, jsonResponse } from "../../../_lib/http";

// GET /api/providers/gemini/models — 검증된 연결의 선택 가능 모델 목록을 새로 조회한다 (외부 호출: models.list).
// 200 { models }, 404 연결 없음, 409 미검증, 429 한도 초과, 422·502·504 Gemini 오류

const SCOPE = "providers.gemini.models";

export async function GET(request: Request): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    return jsonResponse({ models: await listGeminiModels(userId) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
