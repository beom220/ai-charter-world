-- Phase 7-2-1: 사건 시스템(WorldEvent 확장·자동 사건 20장면 구간 추첨 기록)과 캐릭터 신체 상태(체온·부상·생존).
-- 사망한 캐릭터도 Character 행(슬롯)은 그대로 남는다. 기존 캐릭터는 정상·부상 없음·생존 상태로 채운다.

-- CreateEnum
CREATE TYPE "EventIntensity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ThermalState" AS ENUM ('NORMAL', 'COLD', 'VERY_COLD', 'HOT', 'VERY_HOT');

-- CreateEnum
CREATE TYPE "InjurySeverity" AS ENUM ('NONE', 'MILD', 'MODERATE', 'SEVERE', 'CRITICAL');

-- CreateEnum
CREATE TYPE "VitalStatus" AS ENUM ('ALIVE', 'DEAD');

-- CreateEnum
CREATE TYPE "ConditionChangeKind" AS ENUM ('THERMAL', 'INJURY', 'TREATMENT', 'RECOVERY', 'DEATH');

-- AlterEnum


ALTER TYPE "EventStatus" ADD VALUE 'PENDING';
ALTER TYPE "EventStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
ALTER TYPE "WorldEventKind" ADD VALUE 'RANDOM';

-- AlterTable
ALTER TABLE "WorldEvent" ADD COLUMN     "cancelledAt" TIMESTAMPTZ(3),
ADD COLUMN     "claimedAttemptId" VARCHAR(64),
ADD COLUMN     "intensity" "EventIntensity",
ADD COLUMN     "lastSceneSeq" INTEGER,
ADD COLUMN     "presetId" VARCHAR(64),
ADD COLUMN     "requestId" VARCHAR(64),
ADD COLUMN     "resolutionSummary" TEXT,
ADD COLUMN     "resolvedSceneSeq" INTEGER,
ADD COLUMN     "startedSceneSeq" INTEGER;

-- CreateTable
CREATE TABLE "WorldEventPeriod" (
    "worldId" TEXT NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "won" BOOLEAN NOT NULL,
    "scheduledSceneSeq" INTEGER,
    "presetId" VARCHAR(64),
    "eventId" TEXT,
    "firedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorldEventPeriod_pkey" PRIMARY KEY ("worldId","periodIndex")
);

-- CreateTable
CREATE TABLE "CharacterCondition" (
    "characterId" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "thermal" "ThermalState" NOT NULL DEFAULT 'NORMAL',
    "injury" "InjurySeverity" NOT NULL DEFAULT 'NONE',
    "injuryCause" VARCHAR(200),
    "injurySceneSeq" INTEGER,
    "injuryUpdatedSceneSeq" INTEGER,
    "vital" "VitalStatus" NOT NULL DEFAULT 'ALIVE',
    "deathCause" VARCHAR(200),
    "deathSceneSeq" INTEGER,
    "diedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CharacterCondition_pkey" PRIMARY KEY ("characterId")
);

-- CreateTable
CREATE TABLE "CharacterConditionChange" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "sceneId" TEXT,
    "eventId" TEXT,
    "kind" "ConditionChangeKind" NOT NULL,
    "fromValue" VARCHAR(20) NOT NULL,
    "toValue" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CharacterConditionChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CharacterCondition_worldId_idx" ON "CharacterCondition"("worldId");

-- CreateIndex
CREATE UNIQUE INDEX "CharacterCondition_characterId_worldId_key" ON "CharacterCondition"("characterId", "worldId");

-- CreateIndex
CREATE INDEX "CharacterConditionChange_characterId_createdAt_idx" ON "CharacterConditionChange"("characterId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorldEvent_worldId_requestId_key" ON "WorldEvent"("worldId", "requestId");

-- AddForeignKey
ALTER TABLE "WorldEventPeriod" ADD CONSTRAINT "WorldEventPeriod_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorldEventPeriod" ADD CONSTRAINT "WorldEventPeriod_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "WorldEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterCondition" ADD CONSTRAINT "CharacterCondition_characterId_worldId_fkey" FOREIGN KEY ("characterId", "worldId") REFERENCES "Character"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CharacterCondition" ADD CONSTRAINT "CharacterCondition_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterConditionChange" ADD CONSTRAINT "CharacterConditionChange_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterConditionChange" ADD CONSTRAINT "CharacterConditionChange_characterId_worldId_fkey" FOREIGN KEY ("characterId", "worldId") REFERENCES "Character"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CharacterConditionChange" ADD CONSTRAINT "CharacterConditionChange_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "ConversationScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterConditionChange" ADD CONSTRAINT "CharacterConditionChange_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "WorldEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 기존 캐릭터의 신체 상태 (정상·부상 없음·생존)
INSERT INTO "CharacterCondition" ("characterId", "worldId", "updatedAt")
SELECT "id", "worldId", now() FROM "Character";

-- 불변식 (앱 검증이 1차, CHECK 위반은 곧 버그)
ALTER TABLE "CharacterCondition" ADD CONSTRAINT character_condition_death_record
  CHECK ("vital" = 'ALIVE' OR ("deathCause" IS NOT NULL AND "deathSceneSeq" IS NOT NULL AND "diedAt" IS NOT NULL));
ALTER TABLE "CharacterCondition" ADD CONSTRAINT character_condition_injury_cause
  CHECK ("injury" = 'NONE' OR "injuryCause" IS NOT NULL);
ALTER TABLE "WorldEventPeriod" ADD CONSTRAINT world_event_period_schedule
  CHECK ("periodIndex" >= 0 AND "won" = ("scheduledSceneSeq" IS NOT NULL));
ALTER TABLE "WorldEvent" ADD CONSTRAINT world_event_user_text_length
  CHECK ("kind" <> 'USER_INTERVENTION' OR char_length("description") <= 200);

-- 같은 세계관 (nullable · ON DELETE SET NULL 참조)
CREATE TRIGGER condition_change_scene_same_world BEFORE INSERT OR UPDATE OF "sceneId", "worldId" ON "CharacterConditionChange"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('ConversationScene', 'sceneId', 'worldId', 'worldId');
CREATE TRIGGER condition_change_event_same_world BEFORE INSERT OR UPDATE OF "eventId", "worldId" ON "CharacterConditionChange"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('WorldEvent', 'eventId', 'worldId', 'worldId');
CREATE TRIGGER event_period_event_same_world BEFORE INSERT OR UPDATE OF "eventId", "worldId" ON "WorldEventPeriod"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('WorldEvent', 'eventId', 'worldId', 'worldId');
