import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { loadSave } from "@/server/domain/saves/saves";
import { errorResponse, jsonResponse } from "../../../../../_lib/http";

// 저장 불러오기 (Phase 6, architecture.md §9.2). 수동·자동·복구 지점 모두. 본문 없음. Gemini를 호출하지 않는다.
//   POST → 200 { loaded: true, stateVersion }
//   404 저장 없음·타인 소유 / 409 LOAD_REQUIRES_IDLE(실행 중·일시정지·진행 중 장면) · SAVE_CHANGED / 422 SAVE_INVALID(손상·새 버전)

export async function POST(request: Request, ctx: RouteContext<"/api/worlds/[worldId]/saves/[saveId]/load">): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId, saveId } = await ctx.params;
    return jsonResponse({ loaded: true, ...(await loadSave(userId, worldId, saveId)) });
  } catch (error) {
    return errorResponse("saves.load", error);
  }
}
