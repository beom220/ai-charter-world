-- AiProviderConnection: 사용자당 전체 1개 → 사용자당 Provider별 1개 (database.md §3.2, Phase 2-2)
-- 기존 데이터는 (userId) 유일이었으므로 (userId, provider) 유일도 항상 만족한다.

-- DropIndex
DROP INDEX "AiProviderConnection_userId_key";

-- CreateIndex
CREATE UNIQUE INDEX "AiProviderConnection_userId_provider_key" ON "AiProviderConnection"("userId", "provider");

