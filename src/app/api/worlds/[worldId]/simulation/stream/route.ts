import { requireRequestUser } from "@/server/auth/request";
import { openWorldStream } from "@/server/events/world-stream";
import { errorResponse } from "../../../../_lib/http";

// 세계관 실시간 이벤트 (SSE, architecture.md §10.1, Phase 5-3).
//   GET /api/worlds/[worldId]/simulation/stream  (세션 쿠키 인증)
//   재연결: 브라우저가 보내는 Last-Event-ID 헤더. 첫 연결은 ?lastEventId=<페이지 렌더 시점 커서>
//   401 비로그인 / 404 세계관 없음·타인 소유 (스트림을 열기 전에 JSON으로 응답)
//   이 연결은 장면 생성·Gemini 호출을 시작하지 않는다.
//   ?watch=1: 보기 전용(캐릭터 상세 등). 이벤트만 받고 대화 화면 연결로 세지 않는다(연결 보류·이탈 판정 제외).

const SCOPE = "simulation.stream";

export async function GET(request: Request, ctx: RouteContext<"/api/worlds/[worldId]/simulation/stream">): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    const query = new URL(request.url).searchParams;
    const lastEventId = request.headers.get("last-event-id") ?? query.get("lastEventId");
    const stream = await openWorldStream({ userId, worldId, lastEventId, signal: request.signal, presence: query.get("watch") !== "1" });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
