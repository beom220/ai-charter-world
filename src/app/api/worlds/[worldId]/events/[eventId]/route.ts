import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { cancelUserEvent } from "@/server/domain/events/user-events";
import { errorResponse, jsonResponse } from "../../../../_lib/http";

// 대기 사용자 사건 취소 (Phase 7-2-3).
//   DELETE → 200 { cancelled: true }
//   409 USER_EVENT_NOT_CANCELLABLE(이미 발생·취소)·USER_EVENT_IN_PROGRESS(지금 만드는 장면에 포함됨)
//   401 / 403(다른 origin) / 404 세계관·사건 없음·타인 소유

const SCOPE = "events.cancel";

export async function DELETE(request: Request, ctx: RouteContext<"/api/worlds/[worldId]/events/[eventId]">): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId, eventId } = await ctx.params;
    await cancelUserEvent(userId, worldId, eventId);
    return jsonResponse({ cancelled: true });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
