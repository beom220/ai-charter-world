import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { overwriteManualSave } from "@/server/domain/saves/saves";
import { errorResponse, jsonResponse } from "../../../../../_lib/http";

// 수동 저장 덮어쓰기 (Phase 6). 본문 없음. 자동 저장·복구 지점은 404.
//   POST → 200 { save }

export async function POST(request: Request, ctx: RouteContext<"/api/worlds/[worldId]/saves/[saveId]/overwrite">): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId, saveId } = await ctx.params;
    return jsonResponse({ save: await overwriteManualSave(userId, worldId, saveId) });
  } catch (error) {
    return errorResponse("saves.overwrite", error);
  }
}
