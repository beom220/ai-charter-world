import { sceneGenerateInputSchema } from "@/lib/schemas/scene";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { BadRequestError } from "@/server/domain/errors";
import { generateScene } from "@/server/domain/scenes/generate-scene";
import { errorResponse, jsonResponse, readJsonWithLimit } from "../../../_lib/http";

// 대화 장면 1개 생성 (Phase 5-1). 버튼을 누를 때만 Gemini를 1회 호출한다. 자동 재시도 없음.
//   POST /api/worlds/[worldId]/scenes { characterIds: [2~3개] } → 201 { scene }
//   400 참가자 오류 / 404 세계관 없음·타인 소유 / 409 연결 미준비·진행 중·상태 변경 / 422·429·502·504 Gemini·검증 실패

const SCOPE = "scenes";

export async function POST(request: Request, ctx: RouteContext<"/api/worlds/[worldId]/scenes">): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    const parsed = sceneGenerateInputSchema.safeParse(await readJsonWithLimit(request));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message);

    return jsonResponse({ scene: await generateScene(userId, worldId, parsed.data.characterIds) }, 201);
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
