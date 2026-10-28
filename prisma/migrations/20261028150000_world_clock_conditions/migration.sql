-- Phase 7-2-2: 월드 시간(실제 RUNNING 시간 × 36), 온도 불편(원인·단계)·고통(부상과 독립)·극심 지속, 장면·사건·상태 변화의 월드 시각.
-- 기존 신체 상태는 단방향으로 옮긴다(보존적 매핑) 후 이전 열·enum을 지운다:
--   COLD → 추위·경미, VERY_COLD → 추위·심함, HOT → 더위·경미, VERY_HOT → 더위·심함 (극심은 새 단계로 서버가 확정한 변화에만 진입)
--   고통: 부상 MILD·MODERATE → 경미, SEVERE → 심함, CRITICAL → 극심 (7-2-1에서는 통증 = 부상 단계였다)
--   장면 기준 부상 회복 기준(injuryUpdatedSceneSeq)은 월드 시간 기준(injuryUpdatedAtSeconds)으로 바꾸며, 기존 부상은 현재 월드 시각(0)부터 센다.

CREATE TYPE "ThermalCause" AS ENUM ('NONE', 'COLD', 'HEAT');
CREATE TYPE "DiscomfortLevel" AS ENUM ('NONE', 'MILD', 'SEVERE', 'EXTREME');
ALTER TYPE "StatusReason" ADD VALUE 'NOT_ENOUGH_CHARACTERS';

ALTER TABLE "GameState" ADD COLUMN "worldSeconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SimulationRuntime" ADD COLUMN "clockAnchorAt" TIMESTAMPTZ(3), ADD COLUMN "clockCheckpointAt" TIMESTAMPTZ(3);
ALTER TABLE "ConversationScene" ADD COLUMN "worldSeconds" INTEGER;
ALTER TABLE "WorldEvent" ADD COLUMN "startedWorldSeconds" INTEGER, ADD COLUMN "resolvedWorldSeconds" INTEGER;
ALTER TABLE "CharacterConditionChange" ADD COLUMN "worldSeconds" INTEGER;

ALTER TABLE "CharacterCondition"
  ADD COLUMN "thermalCause" "ThermalCause" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "thermalLevel" "DiscomfortLevel" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "thermalSinceSeconds" INTEGER,
  ADD COLUMN "painLevel" "DiscomfortLevel" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "painCause" VARCHAR(200),
  ADD COLUMN "painSinceSeconds" INTEGER,
  ADD COLUMN "injuryUpdatedAtSeconds" INTEGER,
  ADD COLUMN "extremeSinceSeconds" INTEGER,
  ADD COLUMN "deathWorldSeconds" INTEGER;

UPDATE "CharacterCondition" SET
  "thermalCause" = CASE WHEN "thermal" IN ('COLD', 'VERY_COLD') THEN 'COLD'::"ThermalCause" WHEN "thermal" IN ('HOT', 'VERY_HOT') THEN 'HEAT'::"ThermalCause" ELSE 'NONE'::"ThermalCause" END,
  "thermalLevel" = CASE WHEN "thermal" IN ('COLD', 'HOT') THEN 'MILD'::"DiscomfortLevel" WHEN "thermal" IN ('VERY_COLD', 'VERY_HOT') THEN 'SEVERE'::"DiscomfortLevel" ELSE 'NONE'::"DiscomfortLevel" END,
  "thermalSinceSeconds" = CASE WHEN "thermal" <> 'NORMAL' THEN 0 END,
  "painLevel" = CASE "injury" WHEN 'MILD' THEN 'MILD'::"DiscomfortLevel" WHEN 'MODERATE' THEN 'MILD'::"DiscomfortLevel" WHEN 'SEVERE' THEN 'SEVERE'::"DiscomfortLevel" WHEN 'CRITICAL' THEN 'EXTREME'::"DiscomfortLevel" ELSE 'NONE'::"DiscomfortLevel" END,
  "painCause" = CASE WHEN "injury" <> 'NONE' THEN "injuryCause" END,
  "painSinceSeconds" = CASE WHEN "injury" <> 'NONE' THEN 0 END,
  "injuryUpdatedAtSeconds" = CASE WHEN "injury" <> 'NONE' THEN 0 END,
  "extremeSinceSeconds" = CASE WHEN "injury" = 'CRITICAL' THEN 0 END;

ALTER TABLE "CharacterCondition" DROP COLUMN "thermal", DROP COLUMN "injuryUpdatedSceneSeq";
DROP TYPE "ThermalState";

-- 불변식 (앱 검증이 1차, CHECK 위반은 곧 버그)
ALTER TABLE "CharacterCondition" ADD CONSTRAINT character_condition_thermal_pair CHECK (("thermalCause" = 'NONE') = ("thermalLevel" = 'NONE'));
ALTER TABLE "GameState" ADD CONSTRAINT gs_world_seconds CHECK ("worldSeconds" >= 0);
