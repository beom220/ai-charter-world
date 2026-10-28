import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { runSimulationCommand } from "@/server/domain/simulation/control";
import type { SimulationCommand } from "@/server/engine/runner/transitions";
import { errorResponse, jsonResponse } from "./http";

// 시뮬레이션 제어 명령 Route Handler 공통 (Phase 5-4-1). 본문 없음.
//   POST → 200 { state, changed }  (이미 목표 상태면 changed=false)
//   401 / 403(다른 origin) / 404 세계관 없음·타인 소유 / 409 INVALID_TRANSITION·NOT_ENOUGH_CHARACTERS·연결 미준비 / 429 일일 한도

export function simulationCommandHandler(command: SimulationCommand) {
  return async (request: Request, ctx: { params: Promise<{ worldId: string }> }): Promise<Response> => {
    try {
      assertSameOrigin(request);
      const { userId } = await requireRequestUser(request);
      const { worldId } = await ctx.params;
      return jsonResponse(await runSimulationCommand(userId, worldId, command));
    } catch (error) {
      return errorResponse(`simulation.${command}`, error);
    }
  };
}
