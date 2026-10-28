import { z } from "zod";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { BadRequestError } from "@/server/domain/errors";
import { leaveConversation } from "@/server/domain/simulation/client-hold";
import { errorResponse, jsonResponse, readJsonWithLimit } from "../../../../_lib/http";

// 대화 화면 이탈 알림 (UI 개선). 대화 패널이 숨겨지거나 사라질 때 keepalive로 보낸다.
//   POST { connectionId? } → 200 { result }  (inactive | connected | held | paused)
//   그 탭의 연결을 지우고, 이 세계관에 남은 대화 화면 연결이 없으면 바로 일시정지한다(진행 중 장면이 있으면 PAUSING → 완료 후 PAUSED).
//   다른 탭이 대화 화면을 보고 있으면 아무것도 바꾸지 않는다. 401 / 403(다른 origin) / 404 세계관 없음·타인 소유

const bodySchema = z.object({ connectionId: z.string().min(1).max(64).nullable().default(null) }).strip();

export async function POST(request: Request, ctx: RouteContext<"/api/worlds/[worldId]/simulation/leave">): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    const parsed = bodySchema.safeParse(await readJsonWithLimit(request));
    if (!parsed.success) throw new BadRequestError();
    return jsonResponse({ result: await leaveConversation(userId, worldId, parsed.data.connectionId) });
  } catch (error) {
    return errorResponse("simulation.leave", error);
  }
}
