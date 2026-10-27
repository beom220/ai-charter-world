import { characterInputSchema } from "@/lib/schemas/character";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { deleteCharacter, getCharacter, updateCharacter } from "@/server/domain/characters/characters";
import { BadRequestError } from "@/server/domain/errors";
import { errorResponse, jsonResponse, readJsonWithLimit } from "../../../../_lib/http";

// 캐릭터 상세·수정·소프트 삭제 (PRD FR-04). 없거나 타인 소유이거나 삭제된 캐릭터는 404.
//   GET    → 200 { character }
//   PATCH  → 200 { character, changed }
//   DELETE → 200 { deleted: true } (deletedAt 설정, 과거 기록 보존)

const SCOPE = "characters.item";

type Context = RouteContext<"/api/worlds/[worldId]/characters/[characterId]">;

export async function GET(request: Request, ctx: Context): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    const { worldId, characterId } = await ctx.params;
    return jsonResponse({ character: await getCharacter(userId, worldId, characterId) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId, characterId } = await ctx.params;
    const parsed = characterInputSchema.safeParse(await readJsonWithLimit(request));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message);

    return jsonResponse(await updateCharacter(userId, worldId, characterId, parsed.data));
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function DELETE(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId, characterId } = await ctx.params;
    await deleteCharacter(userId, worldId, characterId);
    return jsonResponse({ deleted: true });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
