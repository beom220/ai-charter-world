-- Phase 6: 세이브 종류 일관성. MANUAL·AUTO는 스냅샷 필수, AUTO는 슬롯 1..5, RECOVERY는 세계관당 1개(스냅샷 없으면 아직 복구 지점 없음)
ALTER TABLE "SaveGame" ADD CONSTRAINT save_kind_consistency CHECK (
  (kind = 'MANUAL'   AND "recoveryForWorldId" IS NULL AND "autoSlot" IS NULL AND "snapshotId" IS NOT NULL) OR
  (kind = 'AUTO'     AND "recoveryForWorldId" IS NULL AND "autoSlot" BETWEEN 1 AND 5 AND "snapshotId" IS NOT NULL) OR
  (kind = 'RECOVERY' AND "recoveryForWorldId" = "worldId" AND "autoSlot" IS NULL));
