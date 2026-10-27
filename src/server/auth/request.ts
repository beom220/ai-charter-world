import "server-only";
import { ForbiddenError } from "@/server/domain/errors";
import type { AuthenticatedUser } from "@/server/domain/identity";
import { readAuthEnv } from "./env";
import { requireUserFromHeaders } from "./session";

// Route Handler용 요청 검증 (architecture.md §11.3).

/** 상태를 바꾸는 요청은 앱 origin(BETTER_AUTH_URL)에서 온 것만 허용한다 (CSRF). */
export function assertSameOrigin(request: Request): void {
  const expected = new URL(readAuthEnv(process.env).baseURL).origin;
  if (request.headers.get("origin") !== expected) throw new ForbiddenError();
}

/** 세션 사용자. 요청 본문·쿼리·헤더의 userId는 보지 않는다. */
export function requireRequestUser(request: Request): Promise<AuthenticatedUser> {
  return requireUserFromHeaders(request.headers);
}
