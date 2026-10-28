-- Phase 6: 세이브 슬롯 정책 (수동 5개 + 자동 5개 순환 + 별도 복구 지점 RECOVERY)
-- 기존 AUTO 행(세계관당 1개, LIVE/MATERIALIZED 복구 지점)은 의미 그대로 RECOVERY가 된다(값 이름 변경 → 기존 행이 그대로 RECOVERY).
-- 새 AUTO는 1시간마다 쓰는 자동 저장 슬롯(autoSlot 1..5)이다. 새 enum 값은 같은 트랜잭션에서 쓸 수 없으므로 CHECK는 다음 마이그레이션에서 만든다.

ALTER TABLE "SaveGame" DROP CONSTRAINT save_kind_consistency;
ALTER TYPE "SaveKind" RENAME VALUE 'AUTO' TO 'RECOVERY';
ALTER TYPE "SaveKind" ADD VALUE 'AUTO';

ALTER TABLE "SaveGame" RENAME COLUMN "autoForWorldId" TO "recoveryForWorldId";
ALTER INDEX "SaveGame_autoForWorldId_key" RENAME TO "SaveGame_recoveryForWorldId_key";
UPDATE "SaveGame" SET "name" = '복구 지점' WHERE "kind" = 'RECOVERY';

ALTER TABLE "SaveGame" ADD COLUMN "autoSlot" INTEGER;
CREATE UNIQUE INDEX "SaveGame_worldId_autoSlot_key" ON "SaveGame"("worldId", "autoSlot");

-- 다음 자동 저장 예정 시각 (DB 기준, 재시작 후에도 유지). 이미 실행 중인 세계관은 지금부터 1시간 뒤
ALTER TABLE "SimulationRuntime" ADD COLUMN "nextAutoSaveAt" TIMESTAMPTZ(3);
UPDATE "SimulationRuntime" SET "nextAutoSaveAt" = now() + interval '1 hour' WHERE "status" IN ('RUNNING', 'PAUSING');
