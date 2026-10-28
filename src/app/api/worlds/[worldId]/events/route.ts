import { userEventInputSchema } from "@/lib/schemas/world-event";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { requireOwnedWorld } from "@/server/db/scope";
import { BadRequestError } from "@/server/domain/errors";
import { listPendingUserEvents, submitUserEvent } from "@/server/domain/events/user-events";
import { listActiveEvents } from "@/server/domain/scenes/scene-world";
import { errorResponse, jsonResponse, readJsonWithLimit } from "../../../_lib/http";

// 사건 (Phase 7-2-2 진행 중 사건, 7-2-3 사용자 지정 사건).
//   GET  → 200 { active: [...](오래된 것부터), pending: [{ id, text, createdAt, claimed }](등록 순) }
//   POST { text(≤200자), requestId } → 201 { event } 새 대기 사건 / 200 { event } 같은 requestId 재전송
//        409 USER_EVENT_PENDING_LIMIT(대기 3건)·USER_EVENT_REQUEST_REUSED / 429 USER_EVENT_TOO_SOON(30초)·USER_EVENT_DAILY_LIMIT(KST 하루 30건, Retry-After)
//   401 / 403(다른 origin) / 404 세계관 없음·타인 소유 / 400 형식 오류. 첫 장면 이후에도 등록할 수 있다(설정 변경이 아님)

const SCOPE = "events";
type Context = RouteContext<"/api/worlds/[worldId]/events">;

export async function GET(request: Request, ctx: Context): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    await requireOwnedWorld(userId, worldId);
    const [active, pending] = await Promise.all([listActiveEvents(worldId), listPendingUserEvents(worldId)]);
    return jsonResponse({ active, pending });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function POST(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    const parsed = userEventInputSchema.safeParse(await readJsonWithLimit(request));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message);
    const { event, created } = await submitUserEvent(userId, worldId, parsed.data);
    return jsonResponse({ event }, created ? 201 : 200);
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
