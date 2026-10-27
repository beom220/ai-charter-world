import { geminiApiKeyInputSchema, GEMINI_API_KEY_FORMAT_MESSAGE } from "@/lib/schemas/provider";
import { assertSameOrigin, requireRequestUser } from "@/server/auth/request";
import { BadRequestError } from "@/server/domain/errors";
import { deleteGeminiConnection, getGeminiConnection, saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { errorResponse, jsonResponse, readJson } from "../../_lib/http";

// Gemini BYOK 키 관리 (PRD FR-02, architecture.md §8.1).
//   GET    /api/providers/gemini  → 200 { connection: GeminiConnectionView | null }
//   PUT    /api/providers/gemini  { apiKey } → 201 등록 / 200 교체 { connection, created }
//   DELETE /api/providers/gemini  → 200 { deleted: boolean }
// 모든 요청은 Better Auth 세션으로 사용자를 정한다. 요청의 userId는 무시한다.

const SCOPE = "providers.gemini";

export async function GET(request: Request): Promise<Response> {
  try {
    const { userId } = await requireRequestUser(request);
    return jsonResponse({ connection: await getGeminiConnection(userId) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    const parsed = geminiApiKeyInputSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new BadRequestError(GEMINI_API_KEY_FORMAT_MESSAGE);

    const { connection, created } = await saveGeminiApiKey(userId, parsed.data.apiKey);
    return jsonResponse({ connection, created }, created ? 201 : 200);
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { userId } = await requireRequestUser(request);
    return jsonResponse({ deleted: await deleteGeminiConnection(userId) });
  } catch (error) {
    return errorResponse(SCOPE, error);
  }
}
