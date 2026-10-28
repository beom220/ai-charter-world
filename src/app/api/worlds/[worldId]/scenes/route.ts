import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { BadRequestError } from "@/server/domain/errors";
import { generateScene, listScenes } from "@/server/domain/scenes/generate-scene";
import { errorResponse, jsonResponse } from "../../../_lib/http";

// 대화 장면 (Phase 5-1·5-2).
//   GET  /api/worlds/[worldId]/scenes?before=<seq> → 200 { scenes(새 것부터), hasMore }  '이전 기록 보기'용 seq 커서
//   POST /api/worlds/[worldId]/scenes → 201 { scene }
//     버튼을 누를 때만 Gemini를 1회 호출한다. 자동 재시도 없음.
//     참가자는 서버가 활성 캐릭터 중에서 정한다. 요청 본문은 읽지 않는다(클라이언트가 보낸 캐릭터 ID를 신뢰하지 않음).
//     404 세계관 없음·타인 소유 / 409 활성 캐릭터 부족·연결 미준비·진행 중·상태 변경 / 422·429·502·504 Gemini·검증 실패

const SCOPE = "scenes";

export async function GET(request: Request, ctx: RouteContext<"/api/worlds/[worldId]/scenes">): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    const raw = new URL(request.url).searchParams.get("before");
    const beforeSeq = raw === null ? undefined : Number(raw);
    if (beforeSeq !== undefined && !(Number.isSafeInteger(beforeSeq) && beforeSeq > 0)) throw new BadRequestError();
    return jsonResponse(await listScenes(userId, worldId, { beforeSeq }));
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

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
