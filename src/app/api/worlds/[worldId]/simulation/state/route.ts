import { z } from "zod";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { BadRequestError } from "@/server/domain/errors";
import { getSimulationState, updateSimulationSettings } from "@/server/domain/simulation/control";
import { errorResponse, jsonResponse, readJsonWithLimit } from "../../../../_lib/http";

// 시뮬레이션 상태·실행 속도 (architecture.md §7.2, Phase 5-4-1).
//   GET   /api/worlds/[worldId]/simulation/state                         → 200 { state }
//   PATCH /api/worlds/[worldId]/simulation/state { intervalPreset }      → 200 { state, changed }
//   401 / 404 세계관 없음·타인 소유 / 400 잘못된 값

const SCOPE = "simulation.state";
type Context = RouteContext<"/api/worlds/[worldId]/simulation/state">;

const settingsSchema = z.object({ intervalPreset: z.enum(["SLOW", "NORMAL", "FAST"]) }).strip();

export async function GET(request: Request, ctx: Context): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    return jsonResponse({ state: await getSimulationState(userId, worldId) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const { worldId } = await ctx.params;
    const parsed = settingsSchema.safeParse(await readJsonWithLimit(request));
    if (!parsed.success) throw new BadRequestError("실행 속도는 SLOW·NORMAL·FAST 중 하나여야 합니다.");
    return jsonResponse(await updateSimulationSettings(userId, worldId, parsed.data.intervalPreset));
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
