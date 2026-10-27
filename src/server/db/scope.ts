import type { World } from "@/generated/prisma/client";
import { NotFoundError } from "@/server/domain/errors";
import type { AuthenticatedUserId } from "@/server/domain/identity";
import { prisma } from "@/server/db/client";

// 소유권 스코프 (architecture.md §11.2, CLAUDE.md 절대 규칙 3).
// 세계관 하위 리소스는 반드시 world.ownerId 조건이 포함된 쿼리로만 접근한다.

/** 세계관 조회 조건: id와 소유자를 함께 건다. */
export function ownedWorldWhere(userId: AuthenticatedUserId, worldId: string) {
  return { id: worldId, ownerId: userId };
}

/** 세계관 하위 리소스 조회 조건에 붙이는 소유권 조건. */
export function ownedByUser(userId: AuthenticatedUserId) {
  return { world: { ownerId: userId } };
}

type WorldReader = Pick<typeof prisma, "world">;

/**
 * 현재 사용자가 소유한 세계관만 반환한다. 없거나 타인 소유이면 둘 다 NotFoundError(404)다.
 * 트랜잭션 안에서는 tx를 넘긴다.
 */
export async function requireOwnedWorld(
  userId: AuthenticatedUserId,
  worldId: string,
  db: WorldReader = prisma,
): Promise<World> {
  const world = await db.world.findFirst({ where: ownedWorldWhere(userId, worldId) });
  if (!world) throw new NotFoundError();
  return world;
}
