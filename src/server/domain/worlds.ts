import type { WorldInput } from "@/lib/schemas/world";
import { prisma } from "@/server/db/client";
import { ownedWorldWhere, requireOwnedWorld } from "@/server/db/scope";
import { NotFoundError } from "@/server/domain/errors";
import type { AuthenticatedUserId } from "@/server/domain/identity";

// 세계관 CRUD (PRD FR-03, database.md §6). 런타임 독립 모듈.
// 모든 조회·변경은 ownerId 조건을 건다. 없거나 타인 소유이면 NotFoundError(404)로 구분하지 않는다.

export type RuntimeStatusView = "IDLE" | "RUNNING" | "PAUSING" | "PAUSED";

export type WorldSummaryView = {
  id: string;
  name: string;
  runtimeStatus: RuntimeStatusView;
  createdAt: Date;
  updatedAt: Date;
};

export type WorldDetailView = WorldSummaryView & { worldContext: string };

export const RECOVERY_SAVE_NAME = "복구 지점";

const summarySelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  runtime: { select: { status: true } },
} as const;

type SummaryRow = { id: string; name: string; createdAt: Date; updatedAt: Date; runtime: { status: RuntimeStatusView } | null };

function toSummary({ runtime, ...rest }: SummaryRow): WorldSummaryView {
  // 세계관 생성 트랜잭션이 Runtime을 함께 만들므로 null은 생기지 않는다 (database.md §6)
  return { ...rest, runtimeStatus: runtime?.status ?? "IDLE" };
}

/** 목록에는 worldContext를 담지 않는다 (최대 10MB) */
export async function listWorlds(userId: AuthenticatedUserId): Promise<WorldSummaryView[]> {
  const rows = await prisma.world.findMany({
    where: { ownerId: userId },
    select: summarySelect,
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toSummary);
}

export async function getWorld(userId: AuthenticatedUserId, worldId: string): Promise<WorldDetailView> {
  const row = await prisma.world.findFirst({
    where: ownedWorldWhere(userId, worldId),
    select: { ...summarySelect, worldContext: true },
  });
  if (!row) throw new NotFoundError();
  const { worldContext, ...summary } = row;
  return { ...toSummary(summary), worldContext };
}

/** World + GameState + SimulationRuntime(IDLE) + 복구 지점 행(RECOVERY, 스냅샷 없음)을 한 트랜잭션에서 만든다 (database.md §5, §6) */
export async function createWorld(userId: AuthenticatedUserId, input: WorldInput): Promise<WorldDetailView> {
  const worldId = await prisma.$transaction(async (tx) => {
    const world = await tx.world.create({ data: { ownerId: userId, name: input.name, worldContext: input.worldContext } });
    await tx.gameState.create({ data: { worldId: world.id } });
    await tx.simulationRuntime.create({ data: { worldId: world.id, status: "IDLE" } });
    await tx.saveGame.create({
      data: {
        worldId: world.id,
        kind: "RECOVERY",
        recoveryForWorldId: world.id,
        name: RECOVERY_SAVE_NAME,
        snapshotId: null,
        sceneCount: 0,
        characterCount: 0,
        worldNameSnapshot: world.name,
        stateVersionAtSave: 0,
      },
    });
    return world.id;
  });
  return getWorld(userId, worldId);
}

/** World 행 잠금 (잠금 순서 World → GameState). 타인 소유이면 잠그지 않고 404. 세계관 하위 리소스 변경도 이 잠금으로 시작한다 */
export async function lockOwnedWorld(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], userId: AuthenticatedUserId, worldId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "World" WHERE "id" = ${worldId} AND "ownerId" = ${userId} FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError();
}

/**
 * 세계관 설정 수정 (database.md §6.7). 실행 중에도 허용하고 stateVersion은 올리지 않는다(architecture.md §6.7).
 * 실제로 값이 바뀐 경우에만 GameState.changeSeq += 1 (복구 지점 판정, A13).
 */
export async function updateWorld(
  userId: AuthenticatedUserId,
  worldId: string,
  input: WorldInput,
): Promise<{ world: WorldDetailView; changed: boolean }> {
  const changed = await prisma.$transaction(async (tx) => {
    await lockOwnedWorld(tx, userId, worldId);
    const current = await requireOwnedWorld(userId, worldId, tx);
    if (current.name === input.name && current.worldContext === input.worldContext) return false;

    await tx.world.update({ where: { id: worldId }, data: { name: input.name, worldContext: input.worldContext } });
    await tx.$executeRaw`UPDATE "GameState" SET "changeSeq" = "changeSeq" + 1, "updatedAt" = now() WHERE "worldId" = ${worldId}`;
    return true;
  });
  return { world: await getWorld(userId, worldId), changed };
}

/**
 * 세계관 삭제 (database.md §6.9, §7). 실행 상태와 관계없이 허용하며 하위 데이터는 전부 Cascade로 지운다.
 * World → GameState 순으로 잠가 진행 중인 장면 커밋과 직렬화한다. 삭제 뒤 Runner의 커밋은 GameState가 없어 실패한다.
 * TODO(Phase 5): 실행 중인 Runner에 취소 신호를 보낸다 (엔진 구현 후).
 */
export async function deleteWorld(userId: AuthenticatedUserId, worldId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockOwnedWorld(tx, userId, worldId);
    await tx.$queryRaw`SELECT 1 FROM "GameState" WHERE "worldId" = ${worldId} FOR UPDATE`;
    await tx.world.delete({ where: { id: worldId } });
  });
}
