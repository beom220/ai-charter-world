import { characterInputSchema } from "@/lib/schemas/character";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { createCharacter, listCharacters } from "@/server/domain/characters/characters";
import { BadRequestError } from "@/server/domain/errors";
import { errorResponse, jsonResponse, readJsonWithLimit } from "../../../_lib/http";

// 캐릭터 목록·생성 (PRD FR-04). 세계관이 없거나 타인 소유이면 404.
//   GET  /api/worlds/[worldId]/characters  → 200 { characters: CharacterView[] } (활성 캐릭터만)
//   POST /api/worlds/[worldId]/characters  → 201 { character } / 409 CHARACTER_LIMIT (활성 6명)

const SCOPE = "characters";

type Context = RouteContext<"/api/worlds/[worldId]/characters">;

export async function GET(request: Request, ctx: Context): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    return jsonResponse({ characters: await listCharacters(userId, worldId) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function POST(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    const parsed = characterInputSchema.safeParse(await readJsonWithLimit(request));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message);

    return jsonResponse({ character: await createCharacter(userId, worldId, parsed.data) }, 201);
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
