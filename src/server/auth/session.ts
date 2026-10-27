import "server-only";
import { headers } from "next/headers";
import { UnauthorizedError } from "@/server/domain/errors";
import { asAuthenticatedUserId, type AuthenticatedUser } from "@/server/domain/identity";
import { getAuth } from "./auth";

// 서버 세션 헬퍼 (architecture.md §11.2).
// 사용자 ID는 Better Auth가 서명 쿠키 → DB 세션으로 검증한 값만 쓴다. 요청 본문·쿼리·헤더의 userId는 신뢰하지 않는다.

type SessionReader = {
  api: {
    getSession: (input: { headers: Headers }) => Promise<{
      user: { id: string; name: string; email: string; image?: string | null };
      session: { id: string; expiresAt: Date };
    } | null>;
  };
};

export type CurrentSession = NonNullable<Awaited<ReturnType<SessionReader["api"]["getSession"]>>>;

/** 요청 헤더(쿠키)로 세션을 검증한다. 없거나 만료·무효이면 null. */
export async function getSessionFromHeaders(
  requestHeaders: Headers,
  auth: SessionReader = getAuth(),
): Promise<CurrentSession | null> {
  return auth.api.getSession({ headers: requestHeaders });
}

/** 인증된 사용자만 통과시킨다. 아니면 UnauthorizedError(401). */
export async function requireUserFromHeaders(
  requestHeaders: Headers,
  auth: SessionReader = getAuth(),
): Promise<AuthenticatedUser> {
  const session = await getSessionFromHeaders(requestHeaders, auth);
  if (!session) throw new UnauthorizedError();
  return { userId: asAuthenticatedUserId(session.user.id) };
}

/** Server Component·Route Handler·Server Action에서 현재 세션을 읽는다. */
export async function getCurrentSession(): Promise<CurrentSession | null> {
  return getSessionFromHeaders(await headers());
}

/** 모든 Route Handler와 Server Action은 이 함수로 시작한다 (CLAUDE.md 절대 규칙 3). */
export async function requireUser(): Promise<AuthenticatedUser> {
  return requireUserFromHeaders(await headers());
}
