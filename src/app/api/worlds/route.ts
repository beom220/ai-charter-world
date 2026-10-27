import { worldInputSchema } from "@/lib/schemas/world";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { BadRequestError } from "@/server/domain/errors";
import { createWorld, listWorlds } from "@/server/domain/worlds";
import { errorResponse, jsonResponse, readJsonWithLimit } from "../_lib/http";

// 세계관 목록·생성 (PRD FR-03).
//   GET  /api/worlds                          → 200 { worlds: WorldSummaryView[] } (본인 소유만)
//   POST /api/worlds { name, worldContext }   → 201 { world: WorldDetailView }
// 요청 본문은 최대 10MB(413). 소유자는 세션 사용자로만 정한다.

const SCOPE = "worlds";

export async function GET(request: Request): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    return jsonResponse({ worlds: await listWorlds(userId) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const parsed = worldInputSchema.safeParse(await readJsonWithLimit(request));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message);

    return jsonResponse({ world: await createWorld(userId, parsed.data) }, 201);
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
