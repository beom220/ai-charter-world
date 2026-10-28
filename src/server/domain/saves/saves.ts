import {
  AUTO_SAVE_INTERVAL_MS,
  AUTO_SAVE_RETRY_MS,
  AUTO_SAVE_SLOTS,
  MANUAL_SAVE_SLOTS,
  SAVE_NAME_MAX_LENGTH,
  SAVE_TRANSACTION_TIMEOUT_MS,
  SNAPSHOT_SCHEMA_VERSION,
} from "../../../../config/limits";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { ConflictError, NotFoundError } from "@/server/domain/errors";
import type { AuthenticatedUserId } from "@/server/domain/identity";
import { publishRuntimeStatus } from "@/server/domain/simulation/control";
import { lockOwnedWorld, RECOVERY_SAVE_NAME } from "@/server/domain/worlds";
import { signalRunner } from "@/server/engine/runner/signal";
import { notifyWorld, publishEvents } from "@/server/events/event-bus";
import { logServerError } from "@/server/logging/log";
import { captureSnapshot, parseSnapshot, restoreSnapshot, snapshotChecksum } from "./snapshot";

// 세이브 (architecture.md §9, Phase 6). 런타임 독립.
// 슬롯: 수동(MANUAL) 최대 5 + 자동(AUTO, 슬롯 1..5 순환) 5 = 사용자 목록 10개. 복구 지점(RECOVERY)은 세계관당 1개로 따로 둔다.
// - 저장·덮어쓰기·불러오기·자동 저장은 모두 World → GameState(→ Runtime) 행 잠금을 잡은 한 트랜잭션이다.
//   장면 커밋도 GameState를 잠그므로 캡처는 항상 장면 경계의 한 시점이고, 진행 중 Gemini 요청의 결과는 담기지 않는다.
//   World 잠금으로 같은 세계관의 동시 저장이 직렬화되어 수동 슬롯 5개 제한을 넘지 못한다.
// - 불러오기는 IDLE이고 진행 중 시도가 없을 때만 한다. 직전 상태는 복구 지점 규칙(§9.3, changeSeq)으로 보존하고,
//   stateVersion을 올려 이전 실행의 늦은 결과를 막는다. Runtime은 IDLE(LOADED)로 정리하고 Run·lease·inFlight를 비운다.
// - 이벤트: 슬롯 변경은 saves.updated(목록만 다시 읽음), 불러오기는 state.replaced(화면 전체 재조회) + runtime.status.

type Tx = Prisma.TransactionClient;
type SaveKindValue = "MANUAL" | "AUTO" | "RECOVERY";

export type SaveSlotView = {
  id: string;
  kind: SaveKindValue;
  name: string;
  autoSlot: number | null;
  /** 마지막으로 저장된 시각 (스냅샷 생성 시각. 이름 변경으로는 바뀌지 않는다) */
  savedAt: string;
  sceneCount: number;
  characterCount: number;
};

export type SaveListView = {
  /** 수동·자동 저장, 마지막 저장 시각 내림차순 */
  saves: SaveSlotView[];
  /** 복구 지점 (아직 없으면 null) */
  recovery: SaveSlotView | null;
  manualLimit: number;
  /** 불러오기 가능 여부 (IDLE이고 진행 중 장면 없음) */
  canLoad: boolean;
  /** 마지막 불러오기 표식 (복구 지점의 replacedAtChangeSeq). 바뀌면 화면이 대화 상태를 새로 그린다 */
  replaceMarker: number;
};

const TX = { timeout: SAVE_TRANSACTION_TIMEOUT_MS, maxWait: SAVE_TRANSACTION_TIMEOUT_MS };
const LOCKED_MESSAGE = "시뮬레이션을 종료한 뒤 불러올 수 있습니다.";

const saveSelect = {
  id: true,
  kind: true,
  name: true,
  autoSlot: true,
  sceneCount: true,
  characterCount: true,
  snapshot: { select: { createdAt: true } },
} as const;

type SaveRow = { id: string; kind: SaveKindValue; name: string; autoSlot: number | null; sceneCount: number; characterCount: number; snapshot: { createdAt: Date } | null };

const toView = (r: SaveRow & { snapshot: { createdAt: Date } }): SaveSlotView => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  autoSlot: r.autoSlot,
  savedAt: r.snapshot.createdAt.toISOString(),
  sceneCount: r.sceneCount,
  characterCount: r.characterCount,
});

const withSnapshot = <T extends SaveRow>(r: T): r is T & { snapshot: { createdAt: Date } } => r.snapshot !== null;

export async function listSaves(userId: AuthenticatedUserId, worldId: string): Promise<SaveListView> {
  const world = await prisma.world.findFirst({ where: { id: worldId, ownerId: userId }, select: { runtime: { select: { status: true, inFlightAttemptId: true } } } });
  if (!world) throw new NotFoundError();
  const rows: (SaveRow & { replacedAtChangeSeq: number | null })[] = await prisma.saveGame.findMany({
    where: { worldId },
    select: { ...saveSelect, replacedAtChangeSeq: true },
  });
  const slots = rows.filter((r) => r.kind !== "RECOVERY").filter(withSnapshot).map(toView);
  slots.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  const recovery = rows.find((r) => r.kind === "RECOVERY");
  return {
    saves: slots,
    recovery: recovery && withSnapshot(recovery) ? toView(recovery) : null,
    manualLimit: MANUAL_SAVE_SLOTS,
    canLoad: world.runtime?.status === "IDLE" && world.runtime.inFlightAttemptId === null,
    replaceMarker: recovery?.replacedAtChangeSeq ?? 0,
  };
}

/** World(+GameState) 잠금. 사용자 요청은 소유권 조건으로 잠근다 */
async function lockWorld(tx: Tx, worldId: string, userId: AuthenticatedUserId | null): Promise<void> {
  if (userId) await lockOwnedWorld(tx, userId, worldId);
  else if ((await tx.$queryRaw<unknown[]>`SELECT 1 FROM "World" WHERE "id" = ${worldId} FOR UPDATE`).length === 0) throw new NotFoundError();
  await tx.$queryRaw`SELECT 1 FROM "GameState" WHERE "worldId" = ${worldId} FOR UPDATE`;
}

/** 현재 상태를 캡처해 스냅샷 행을 만든다. 슬롯 표시용 메타데이터도 돌려준다 */
async function writeSnapshot(tx: Tx, worldId: string, now: Date) {
  const payload = await captureSnapshot(tx, worldId, now);
  const { checksum, sizeBytes } = snapshotChecksum(payload);
  const snapshot = await tx.gameSnapshot.create({
    data: { worldId, schemaVersion: SNAPSHOT_SCHEMA_VERSION, payload, checksum, sizeBytes, createdAt: now },
    select: { id: true },
  });
  const gs = await tx.gameState.findUniqueOrThrow({ where: { worldId }, select: { stateVersion: true } });
  return {
    snapshotId: snapshot.id,
    meta: {
      sceneCount: payload.scenes.length,
      characterCount: payload.characters.filter((c) => c.deletedAt === null).length,
      worldNameSnapshot: payload.world.name,
      stateVersionAtSave: gs.stateVersion,
    },
  };
}

async function publishSaves(tx: Tx, worldId: string): Promise<void> {
  await publishEvents(tx, worldId, [{ type: "saves.updated", payload: { worldId } }]);
}

const truncate = (s: string, max: number) => Array.from(s).slice(0, max).join("");

/** 수동 저장 새로 만들기. 이미 5개면 409 (World 잠금으로 동시 요청도 5개를 넘지 못한다) */
export async function createManualSave(userId: AuthenticatedUserId, worldId: string, name: string, now: Date = new Date()): Promise<SaveSlotView> {
  const id = await prisma.$transaction(async (tx) => {
    await lockWorld(tx, worldId, userId);
    if ((await tx.saveGame.count({ where: { worldId, kind: "MANUAL" } })) >= MANUAL_SAVE_SLOTS) {
      throw new ConflictError("SAVE_SLOT_LIMIT", `수동 저장은 최대 ${MANUAL_SAVE_SLOTS}개입니다. 기존 저장을 덮어쓰거나 삭제하세요.`);
    }
    const { snapshotId, meta } = await writeSnapshot(tx, worldId, now);
    const save = await tx.saveGame.create({ data: { worldId, kind: "MANUAL", name: truncate(name, SAVE_NAME_MAX_LENGTH), snapshotId, ...meta }, select: { id: true } });
    await publishSaves(tx, worldId);
    return save.id;
  }, TX);
  notifyWorld(worldId);
  return getSlot(worldId, id);
}

async function getSlot(worldId: string, id: string): Promise<SaveSlotView> {
  const row: SaveRow | null = await prisma.saveGame.findFirst({ where: { id, worldId }, select: saveSelect });
  if (!row || !withSnapshot(row)) throw new NotFoundError();
  return toView(row);
}

/** 수동 저장 덮어쓰기. 새 스냅샷으로 바꾸고 이전 스냅샷은 지운다. 자동 저장·복구 지점은 대상이 아니다(404) */
export async function overwriteManualSave(userId: AuthenticatedUserId, worldId: string, saveId: string, now: Date = new Date()): Promise<SaveSlotView> {
  await prisma.$transaction(async (tx) => {
    await lockWorld(tx, worldId, userId);
    const save = await tx.saveGame.findFirst({ where: { id: saveId, worldId, kind: "MANUAL" }, select: { snapshotId: true } });
    if (!save) throw new NotFoundError();
    const { snapshotId, meta } = await writeSnapshot(tx, worldId, now);
    await tx.saveGame.update({ where: { id: saveId }, data: { snapshotId, ...meta } });
    if (save.snapshotId) await tx.gameSnapshot.delete({ where: { id: save.snapshotId } });
    await publishSaves(tx, worldId);
  }, TX);
  notifyWorld(worldId);
  return getSlot(worldId, saveId);
}

export async function renameManualSave(userId: AuthenticatedUserId, worldId: string, saveId: string, name: string): Promise<SaveSlotView> {
  await prisma.$transaction(async (tx) => {
    await lockOwnedWorld(tx, userId, worldId);
    const { count } = await tx.saveGame.updateMany({ where: { id: saveId, worldId, kind: "MANUAL" }, data: { name: truncate(name, SAVE_NAME_MAX_LENGTH) } });
    if (count === 0) throw new NotFoundError();
    await publishSaves(tx, worldId);
  });
  notifyWorld(worldId);
  return getSlot(worldId, saveId);
}

export async function deleteManualSave(userId: AuthenticatedUserId, worldId: string, saveId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockOwnedWorld(tx, userId, worldId);
    const save = await tx.saveGame.findFirst({ where: { id: saveId, worldId, kind: "MANUAL" }, select: { snapshotId: true } });
    if (!save) throw new NotFoundError();
    await tx.saveGame.delete({ where: { id: saveId } });
    if (save.snapshotId) await tx.gameSnapshot.delete({ where: { id: save.snapshotId } });
    await publishSaves(tx, worldId);
  });
  notifyWorld(worldId);
}

/**
 * 저장(수동·자동·복구 지점) 불러오기. IDLE이고 진행 중 장면이 없을 때만 한다.
 * 복구 지점 규칙(§9.3): 불러오기 직전 상태를 RECOVERY로 보존한다. 지난 불러오기 이후 변경이 없으면(changeSeq == replacedAtChangeSeq)
 * 기존 복구 지점을 그대로 둔다. 복구 지점 자체를 불러올 때는 현재 상태와 맞바꾼다(되돌리기를 다시 되돌릴 수 있게).
 */
export async function loadSave(userId: AuthenticatedUserId, worldId: string, saveId: string, now: Date = new Date()): Promise<{ stateVersion: number }> {
  // 검증은 트랜잭션 전에 한 번 (잠금 시간을 줄인다). 트랜잭션 안에서 같은 스냅샷인지 다시 확인한다
  const target = await prisma.saveGame.findFirst({
    where: { id: saveId, worldId, world: { ownerId: userId } },
    select: { kind: true, snapshot: { select: { id: true, schemaVersion: true, payload: true, checksum: true } } },
  });
  if (!target?.snapshot) throw new NotFoundError();
  const payload = parseSnapshot(target.snapshot);
  const snapshotId = target.snapshot.id;

  const result = await prisma.$transaction(async (tx) => {
    await lockWorld(tx, worldId, userId);
    await tx.$queryRaw`SELECT 1 FROM "SimulationRuntime" WHERE "worldId" = ${worldId} FOR UPDATE`;
    const runtime = await tx.simulationRuntime.findUniqueOrThrow({ where: { worldId }, select: { status: true, inFlightAttemptId: true } });
    if (runtime.status !== "IDLE" || runtime.inFlightAttemptId !== null) throw new ConflictError("LOAD_REQUIRES_IDLE", LOCKED_MESSAGE);
    const current = await tx.saveGame.findFirst({ where: { id: saveId, worldId }, select: { snapshotId: true } });
    if (current?.snapshotId !== snapshotId) throw new ConflictError("SAVE_CHANGED", "저장이 방금 바뀌었습니다. 목록을 새로 고친 뒤 다시 시도하세요.");

    // 복구 지점 (없으면 만든다)
    const gs = await tx.gameState.findUniqueOrThrow({ where: { worldId }, select: { changeSeq: true } });
    let recovery = await tx.saveGame.findUnique({ where: { recoveryForWorldId: worldId }, select: { id: true, snapshotId: true, replacedAtChangeSeq: true } });
    recovery ??= await tx.saveGame.create({
      data: { worldId, kind: "RECOVERY", recoveryForWorldId: worldId, name: RECOVERY_SAVE_NAME, sceneCount: 0, characterCount: 0, worldNameSnapshot: "", stateVersionAtSave: 0 },
      select: { id: true, snapshotId: true, replacedAtChangeSeq: true },
    });
    const loadingRecovery = target.kind === "RECOVERY";
    const unchangedSinceLastLoad = recovery.snapshotId !== null && recovery.replacedAtChangeSeq !== null && gs.changeSeq <= recovery.replacedAtChangeSeq;
    let staleRecoverySnapshot: string | null = null;
    if (loadingRecovery || !unchangedSinceLastLoad) {
      const { snapshotId: captured, meta } = await writeSnapshot(tx, worldId, now);
      staleRecoverySnapshot = recovery.snapshotId;
      await tx.saveGame.update({ where: { id: recovery.id }, data: { snapshotId: captured, ...meta } });
    }
    if (staleRecoverySnapshot) await tx.gameSnapshot.delete({ where: { id: staleRecoverySnapshot } });

    const restored = await restoreSnapshot(tx, worldId, payload);
    await tx.saveGame.update({ where: { id: recovery.id }, data: { replacedAtChangeSeq: restored.changeSeq } });
    await tx.simulationRuntime.update({
      where: { worldId },
      data: {
        status: "IDLE",
        statusReason: "LOADED",
        currentRunId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        inFlightAttemptId: null,
        inFlightStartedAt: null,
        nextSceneAt: null,
        clientHoldSince: null,
        nextAutoSaveAt: null,
      },
    });
    await publishEvents(tx, worldId, [
      { type: "state.replaced", payload: { worldId, reason: loadingRecovery ? "recovery" : "load", stateVersion: restored.stateVersion } },
      { type: "saves.updated", payload: { worldId } },
    ]);
    await publishRuntimeStatus(tx, worldId);
    return { stateVersion: restored.stateVersion };
  }, TX);
  notifyWorld(worldId);
  signalRunner(worldId);
  return result;
}

/**
 * 자동 저장 1회 (RunnerHost 스위퍼가 부른다, Gemini 호출 없음). RUNNING이고 nextAutoSaveAt이 지났을 때만 저장한다.
 * 슬롯은 비어 있는 가장 작은 번호, 모두 차 있으면 가장 오래전에 저장된 번호(1→2→…→5→1 순환)를 덮어쓴다.
 * 조건 확인과 다음 예정 시각 갱신이 같은 잠금 트랜잭션이므로 여러 호스트가 동시에 불러도 한 번만 저장한다.
 * 실패하면 트랜잭션 전체가 롤백되어 기존 스냅샷이 남고, 다음 시도는 AUTO_SAVE_RETRY_MS 뒤로 미룬다.
 */
export async function runAutoSave(worldId: string, now: Date = new Date()): Promise<"saved" | "skipped"> {
  try {
    const saved = await prisma.$transaction(async (tx) => {
      await lockWorld(tx, worldId, null);
      const rt = await tx.simulationRuntime.findUnique({ where: { worldId }, select: { status: true, nextAutoSaveAt: true } });
      if (!rt || rt.status !== "RUNNING" || !rt.nextAutoSaveAt || rt.nextAutoSaveAt > now) return false;

      const autos = await tx.saveGame.findMany({ where: { worldId, kind: "AUTO" }, select: { id: true, autoSlot: true, snapshotId: true, snapshot: { select: { createdAt: true } } } });
      const used = new Set(autos.map((a) => a.autoSlot));
      const free = Array.from({ length: AUTO_SAVE_SLOTS }, (_, i) => i + 1).find((n) => !used.has(n));
      const oldest = [...autos].sort((a, b) => (a.snapshot?.createdAt.getTime() ?? 0) - (b.snapshot?.createdAt.getTime() ?? 0))[0];
      const slot = free ?? oldest!.autoSlot!;
      const previous = autos.find((a) => a.autoSlot === slot);

      const { snapshotId, meta } = await writeSnapshot(tx, worldId, now);
      const suffix = ` - Auto Save ${slot}`;
      const name = `${truncate(meta.worldNameSnapshot, SAVE_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
      if (previous) {
        await tx.saveGame.update({ where: { id: previous.id }, data: { name, snapshotId, ...meta } });
        if (previous.snapshotId) await tx.gameSnapshot.delete({ where: { id: previous.snapshotId } });
      } else {
        await tx.saveGame.create({ data: { worldId, kind: "AUTO", autoSlot: slot, name, snapshotId, ...meta } });
      }
      await tx.simulationRuntime.update({ where: { worldId }, data: { nextAutoSaveAt: new Date(now.getTime() + AUTO_SAVE_INTERVAL_MS) } });
      await publishSaves(tx, worldId);
      return true;
    }, TX);
    if (saved) notifyWorld(worldId);
    return saved ? "saved" : "skipped";
  } catch (error) {
    logServerError("autosave", error);
    await prisma.simulationRuntime
      .updateMany({ where: { worldId, nextAutoSaveAt: { lte: now } }, data: { nextAutoSaveAt: new Date(now.getTime() + AUTO_SAVE_RETRY_MS) } })
      .catch((e: unknown) => logServerError("autosave.retry", e));
    return "skipped";
  }
}
