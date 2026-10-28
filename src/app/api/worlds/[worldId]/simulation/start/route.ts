import { simulationCommandHandler } from "../../../../_lib/simulation-command";

// POST /api/worlds/[worldId]/simulation/start (architecture.md §7.2). Runner·Gemini 호출은 시작하지 않는다(Phase 5-4-1).
export const POST = simulationCommandHandler("start");
