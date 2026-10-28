import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { generateScene } from "@/server/domain/scenes/generate-scene";
import { errorResponse, jsonResponse } from "../../../_lib/http";

// 대화 장면 1개 생성 (Phase 5-1). 버튼을 누를 때만 Gemini를 1회 호출한다. 자동 재시도 없음.
// 참가자는 서버가 활성 캐릭터 중에서 정한다. 요청 본문은 읽지 않는다(클라이언트가 보낸 캐릭터 ID를 신뢰하지 않음).
//   POST /api/worlds/[worldId]/scenes → 201 { scene }
//   404 세계관 없음·타인 소유 / 409 활성 캐릭터 부족·연결 미준비·진행 중·상태 변경 / 422·429·502·504 Gemini·검증 실패

const SCOPE = "scenes";

export async function POST(request: Request, ctx: RouteContext<"/api/worlds/[worldId]/scenes">): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    return jsonResponse({ scene: await generateScene(userId, worldId) }, 201);
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
