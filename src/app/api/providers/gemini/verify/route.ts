import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { verifyGeminiConnection } from "@/server/domain/providers/gemini-verification";
import { errorResponse, jsonResponse } from "../../../_lib/http";

// POST /api/providers/gemini/verify — 사용자가 "검증"을 누를 때만 호출한다 (외부 호출: models.list).
// 200 { verification: { ok } | { ok: false, code, message }, connection, models, modelReselectRequired }
// 404 연결 없음, 429 확인 요청 한도 초과(Retry-After)

const SCOPE = "providers.gemini.verify";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    return jsonResponse(await verifyGeminiConnection(userId));
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
