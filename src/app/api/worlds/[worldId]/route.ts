import { worldInputSchema } from "@/lib/schemas/world";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { BadRequestError } from "@/server/domain/errors";
import { deleteWorld, getWorld, updateWorld } from "@/server/domain/worlds";
import { errorResponse, jsonResponse, readJsonWithLimit } from "../../_lib/http";

// 세계관 상세·수정·삭제 (PRD FR-03). 없거나 타인 소유이면 404.
//   GET    /api/worlds/[worldId]                          → 200 { world }
//   PATCH  /api/worlds/[worldId] { name, worldContext }   → 200 { world, changed }
//   DELETE /api/worlds/[worldId]                          → 200 { deleted: true } (하위 데이터 전체 Cascade)

const SCOPE = "worlds.item";

type Context = RouteContext<"/api/worlds/[worldId]">;

export async function GET(request: Request, ctx: Context): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    return jsonResponse({ world: await getWorld(userId, worldId) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    const parsed = worldInputSchema.safeParse(await readJsonWithLimit(request));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message);

    return jsonResponse(await updateWorld(userId, worldId, parsed.data));
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function DELETE(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    await deleteWorld(userId, worldId);
    return jsonResponse({ deleted: true });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
