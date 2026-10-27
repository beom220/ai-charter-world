import { characterRandomRequestSchema } from "@/lib/schemas/character";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { requireOwnedWorld } from "@/server/db/scope";
import { randomizeCharacter } from "@/server/domain/characters/random";
import { BadRequestError } from "@/server/domain/errors";
import { errorResponse, jsonResponse, readJsonWithLimit } from "../../../../_lib/http";

// 캐릭터 랜덤 초안 (PRD FR-04, architecture.md §13). 규칙 기반이며 LLM·DB 쓰기가 없다.
//   POST { draft, lockedFields, fields? } → 200 { draft }
//   fields 없음 = 전체 랜덤, 있음 = 항목별 랜덤. lockedFields는 어느 쪽이든 유지한다.

const SCOPE = "characters.random";

export async function POST(request: Request, ctx: RouteContext<"/api/worlds/[worldId]/characters/random">): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    await requireOwnedWorld(userId, worldId);
    const parsed = characterRandomRequestSchema.safeParse(await readJsonWithLimit(request));
    if (!parsed.success) throw new BadRequestError();

    const { draft, lockedFields, fields } = parsed.data;
    return jsonResponse({ draft: randomizeCharacter(draft, { lockedFields, fields }) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
