import { saveNameSchema } from "@/lib/schemas/save";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { BadRequestError } from "@/server/domain/errors";
import { createManualSave, listSaves } from "@/server/domain/saves/saves";
import { errorResponse, jsonResponse, readJsonWithLimit } from "../../../_lib/http";

// 세이브 목록·수동 저장 (Phase 6, architecture.md §9).
//   GET  → 200 { saves(수동·자동, 마지막 저장 시각 내림차순), recovery, manualLimit, canLoad }
//   POST { name } → 201 { save }   수동 저장 새로 만들기. 5개면 409 SAVE_SLOT_LIMIT
//   401 / 403(다른 origin) / 404 세계관 없음·타인 소유 / 400 이름 형식

const SCOPE = "saves";
type Context = RouteContext<"/api/worlds/[worldId]/saves">;

export async function GET(request: Request, ctx: Context): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    return jsonResponse(await listSaves(userId, worldId));
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function POST(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    const parsed = saveNameSchema.safeParse(await readJsonWithLimit(request));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message);
    return jsonResponse({ save: await createManualSave(userId, worldId, parsed.data.name) }, 201);
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
