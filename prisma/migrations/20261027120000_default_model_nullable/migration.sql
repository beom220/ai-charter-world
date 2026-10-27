-- AiProviderConnection.defaultModel: NOT NULL → nullable (Phase 3-1 결정)
-- 키 등록 시점에는 모델을 정하지 않는다(A17). 기존 행의 값은 그대로 유지된다(제약 완화만 수행).

-- AlterTable
ALTER TABLE "AiProviderConnection" ALTER COLUMN "defaultModel" DROP NOT NULL;

