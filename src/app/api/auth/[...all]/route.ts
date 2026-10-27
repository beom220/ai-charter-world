import { getAuth } from "@/server/auth/auth";
import { AuthConfigError } from "@/server/auth/env";

// Better Auth 핸들러 (/api/auth/*). Google OAuth 시작·콜백, 세션 조회, 로그아웃.
// cacheComponents 사용 시 `runtime` segment config를 둘 수 없다. Route Handler는 기본 Node.js runtime으로 실행된다.

async function handle(request: Request): Promise<Response> {
  try {
    return await getAuth().handler(request);
  } catch (error) {
    if (error instanceof AuthConfigError) {
      // 변수 이름만 로그에 남긴다 (값은 담기지 않음)
      console.error(`[auth] ${error.message}`);
      return Response.json(
        { error: { code: "AUTH_NOT_CONFIGURED", message: "인증 설정이 완료되지 않았습니다." } },
        { status: 500 },
      );
    }
    throw error;
  }
}

export const GET = handle;
export const POST = handle;
