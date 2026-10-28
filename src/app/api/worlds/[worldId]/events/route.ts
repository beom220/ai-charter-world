import { requireRequestUser } from "@/server/auth/request";
import { requireOwnedWorld } from "@/server/db/scope";
import { listActiveEvents } from "@/server/domain/scenes/scene-world";
import { errorResponse, jsonResponse } from "../../../_lib/http";

// 진행 중 사건 (Phase 7-2-2, 대화 화면 시스템 영역).
//   GET /api/worlds/[worldId]/events → 200 { active: [...] } (오래된 것부터)
//   401 / 404 세계관 없음·타인 소유. 사용자 사건 등록·취소는 7-2-3에서 추가한다.

const SCOPE = "events";

export async function GET(request: Request, ctx: RouteContext<"/api/worlds/[worldId]/events">): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    await requireOwnedWorld(userId, worldId);
    return jsonResponse({ active: await listActiveEvents(worldId) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
