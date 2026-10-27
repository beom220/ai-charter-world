import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { prisma as devDb } from "@/server/db/client";

// 새 DB에 prisma/migrations 전체를 처음부터 적용(재현)한 결과가 개발 DB와 같은지 검증한다.
// Prisma가 관리하지 않는 객체(CHECK 제약, 트리거, 트리거 함수)까지 카탈로그로 비교한다.
// 임시 DB(acw_replay_*)만 만들고 지우며, 개발 DB는 읽기만 한다.

const REPLAY_PREFIX = "acw_replay_";
const replayName = `${REPLAY_PREFIX}${randomUUID().replaceAll("-", "")}`;
const prismaBin = path.resolve("node_modules/.bin/prisma");

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const devUrl = process.env.DATABASE_URL!;
const replayUrl = withDatabase(devUrl, replayName);
let admin: PrismaClient;
let replayDb: PrismaClient;

function runPrisma(args: string[]): string {
  return execFileSync(prismaBin, args, {
    env: { ...process.env, DATABASE_URL: replayUrl, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type Db = PrismaClient | typeof devDb;

async function catalog(db: Db) {
  const q = (sql: string) => db.$queryRawUnsafe<{ v: string }[]>(sql).then((rows) => rows.map((r) => r.v));
  return {
    columns: await q(`
      SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS v
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY 1`),
    constraints: await q(`
      SELECT conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) AS v
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> '"_prisma_migrations"' ORDER BY 1`),
    indexes: await q(`SELECT indexdef AS v FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`),
    triggers: await q(`
      SELECT pg_get_triggerdef(t.oid) AS v FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal ORDER BY 1`),
    functions: await q(`
      SELECT proname || ':' || md5(prosrc) AS v FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1`),
    enums: await q(`
      SELECT t.typname || ':' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS v
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname ORDER BY 1`),
    migrations: await q(`SELECT migration_name AS v FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1`),
  };
}

beforeAll(async () => {
  admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: withDatabase(devUrl, "postgres") }) });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${replayName}"`);
  replayDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: replayUrl }) });
}, 60_000);

afterAll(async () => {
  await replayDb?.$disconnect();
  if (replayName.startsWith(REPLAY_PREFIX)) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${replayName}" WITH (FORCE)`);
  }
  await admin.$disconnect();
  await devDb.$disconnect();
}, 60_000);

describe("전체 마이그레이션 재현", () => {
  it("새 DB에 모든 마이그레이션이 적용된다", () => {
    const out = runPrisma(["migrate", "deploy"]);
    expect(out).toMatch(/All migrations have been successfully applied/);
  }, 120_000);

  it("재현 DB의 스키마가 prisma/schema.prisma와 일치한다 (drift 없음)", () => {
    // --exit-code: 차이가 있으면 2로 종료하여 execFileSync가 예외를 던진다
    const out = runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"]);
    expect(out).toMatch(/No difference detected/);
  }, 60_000);

  it("재현 DB의 카탈로그(컬럼·제약·인덱스·트리거·함수·enum·마이그레이션)가 개발 DB와 같다", async () => {
    const [replay, dev] = await Promise.all([catalog(replayDb), catalog(devDb)]);
    expect(replay).toEqual(dev);
    expect(replay.triggers).toHaveLength(11);
    expect(replay.constraints.filter((c) => c.includes(":CHECK ("))).toHaveLength(10);
    expect(replay.functions).toEqual([expect.stringMatching(/^enforce_same_scope:/)]);
  });

  it("재현 DB에서도 트리거가 INSERT·UPDATE를 거부한다", async () => {
    const mk = async (label: string) => {
      const userId = `replay_${label}_${randomUUID()}`;
      await replayDb.user.create({ data: { id: userId, name: label, email: `${userId}@example.test` } });
      const world = await replayDb.world.create({ data: { ownerId: userId, name: label } });
      const snapshot = await replayDb.gameSnapshot.create({
        data: { worldId: world.id, schemaVersion: 1, payload: {}, sizeBytes: 2, checksum: "0".repeat(64) },
      });
      return { userId, world, snapshot };
    };
    const a = await mk("A");
    const b = await mk("B");
    const save = {
      worldId: a.world.id,
      kind: "MANUAL" as const,
      name: "x",
      sceneCount: 0,
      characterCount: 0,
      worldNameSnapshot: "x",
      stateVersionAtSave: 0,
    };

    await expect(replayDb.saveGame.create({ data: { ...save, snapshotId: b.snapshot.id } })).rejects.toThrow(
      /save_snapshot_same_world/,
    );
    const ok = await replayDb.saveGame.create({ data: { ...save, snapshotId: a.snapshot.id } });
    await expect(replayDb.saveGame.update({ where: { id: ok.id }, data: { snapshotId: b.snapshot.id } })).rejects.toThrow(
      /save_snapshot_same_world/,
    );
    await expect(
      replayDb.sseConnection.create({ data: { worldId: a.world.id, userId: b.userId, instanceId: "h" } }),
    ).rejects.toThrow(/sse_connection_world_owner/);
  });
});
