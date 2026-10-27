-- Phase 3-3 사용량 계측: 호출 직전 예약(PENDING), 사용량 상태 구분, 토큰 미확인 요청 수
-- 기존 데이터는 삭제하지 않는다. 아래 backfill은 기존 ApiRequestLog로 상태와 일별 집계를 채운다.

-- CreateEnum
CREATE TYPE "ApiUsageStatus" AS ENUM ('REPORTED', 'MISSING', 'UNKNOWN', 'NOT_APPLICABLE');

-- AlterEnum
ALTER TYPE "ApiOutcome" ADD VALUE 'PENDING';

-- AlterTable
ALTER TABLE "ApiRequestLog" ADD COLUMN     "usageStatus" "ApiUsageStatus";

-- AlterTable
ALTER TABLE "ApiUsageDaily" ADD COLUMN     "unmeteredRequestCount" INTEGER NOT NULL DEFAULT 0;


-- ─────────────────────────────────────────────
-- Backfill (기존 데이터)
-- ─────────────────────────────────────────────

-- 1) 기존 호출 기록의 사용량 상태
--    · 모델 목록 호출("(models.list)") → NOT_APPLICABLE
--    · 토큰이 기록된 행 → REPORTED
--    · 시간 초과·5xx·네트워크로 끝난 모델 호출 → UNKNOWN (생성 요청이었다면 과금 여부 불명)
--    · 그 밖(모델 조회 성공, 생성 전에 거부된 4xx) → NOT_APPLICABLE
UPDATE "ApiRequestLog" SET "usageStatus" = CASE
    WHEN "model" LIKE '(%' THEN 'NOT_APPLICABLE'::"ApiUsageStatus"
    WHEN "inputTokens" IS NOT NULL OR "outputTokens" IS NOT NULL OR "thoughtTokens" IS NOT NULL THEN 'REPORTED'::"ApiUsageStatus"
    WHEN "errorCode" IN ('TIMEOUT', 'UPSTREAM_ERROR', 'NETWORK_ERROR') THEN 'UNKNOWN'::"ApiUsageStatus"
    ELSE 'NOT_APPLICABLE'::"ApiUsageStatus"
  END
WHERE "usageStatus" IS NULL;

-- 2) 연결별·KST 날짜별 집계를 호출 기록에 맞춘다 (호출 기록이 기준)
INSERT INTO "ApiUsageDaily" ("connectionId", "usageDate", "requestCount", "inputTokens", "outputTokens", "thoughtTokens", "unmeteredRequestCount")
SELECT "connectionId",
       ("createdAt" AT TIME ZONE 'Asia/Seoul')::date,
       count(*),
       coalesce(sum("inputTokens"), 0),
       coalesce(sum("outputTokens"), 0),
       coalesce(sum("thoughtTokens"), 0),
       count(*) FILTER (WHERE "usageStatus" IN ('MISSING', 'UNKNOWN'))
FROM "ApiRequestLog"
WHERE "connectionId" IS NOT NULL
GROUP BY "connectionId", ("createdAt" AT TIME ZONE 'Asia/Seoul')::date
ON CONFLICT ("connectionId", "usageDate") DO UPDATE SET
  "requestCount" = EXCLUDED."requestCount",
  "inputTokens" = EXCLUDED."inputTokens",
  "outputTokens" = EXCLUDED."outputTokens",
  "thoughtTokens" = EXCLUDED."thoughtTokens",
  "unmeteredRequestCount" = EXCLUDED."unmeteredRequestCount";
