import { saveNameSchema } from "@/lib/schemas/save";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { BadRequestError } from "@/server/domain/errors";
import { deleteManualSave, renameManualSave } from "@/server/domain/saves/saves";
import { errorResponse, jsonResponse, readJsonWithLimit } from "../../../../_lib/http";

// 수동 저장 이름 변경·삭제 (Phase 6). 자동 저장·복구 지점·타인 저장은 404.
//   PATCH { name } → 200 { save }
//   DELETE         → 200 { deleted: true }

const SCOPE = "saves.item";
type Context = RouteContext<"/api/worlds/[worldId]/saves/[saveId]">;

export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId, saveId } = await ctx.params;
    const parsed = saveNameSchema.safeParse(await readJsonWithLimit(request));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message);
    return jsonResponse({ save: await renameManualSave(userId, worldId, saveId, parsed.data.name) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function DELETE(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId, saveId } = await ctx.params;
    await deleteManualSave(userId, worldId, saveId);
    return jsonResponse({ deleted: true });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
