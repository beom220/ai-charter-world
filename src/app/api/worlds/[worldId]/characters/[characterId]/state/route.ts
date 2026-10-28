import { requireRequestUser } from "@/server/auth/request";
import { getCharacter } from "@/server/domain/characters/characters";
import { getCharacterInsights } from "@/server/domain/characters/insights";
import { errorResponse, jsonResponse } from "../../../../../_lib/http";

// 캐릭터 현재 상태 (Phase 6, 상세 화면 실시간 갱신). 감정·관계·기억 현재 값. 없거나 타인 소유·삭제면 404.
//   GET → 200 { emotion, relations, memories }

export async function GET(request: Request, ctx: RouteContext<"/api/worlds/[worldId]/characters/[characterId]/state">): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    const { worldId, characterId } = await ctx.params;
    const [character, insights] = await Promise.all([getCharacter(userId, worldId, characterId), getCharacterInsights(userId, worldId, characterId)]);
    return jsonResponse({ emotion: character.emotion, ...insights });
  } catch (error) {
    return errorResponse("characters.state", error);
  }
}
