// 서버가 검증한 세션에서 나온 사용자 ID만 소유권 검사에 쓸 수 있도록 타입으로 구분한다.
// 요청 본문·쿼리·헤더의 문자열은 AuthenticatedUserId가 아니므로 소유권 헬퍼에 넘길 수 없다.

declare const authenticatedUserIdBrand: unique symbol;

export type AuthenticatedUserId = string & { readonly [authenticatedUserIdBrand]: true };

export type AuthenticatedUser = {
  userId: AuthenticatedUserId;
};

/**
 * 검증된 세션의 사용자 ID에만 호출한다.
 * 호출 위치: src/server/auth/session.ts, Worker의 Runner(world.ownerId 확정 후), 테스트.
 */
export function asAuthenticatedUserId(userId: string): AuthenticatedUserId {
  return userId as AuthenticatedUserId;
}
