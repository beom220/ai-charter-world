-- 동일 세계관·동일 사용자 참조 무결성 (database.md §4.3)
-- 1) 필수 참조: (참조 id, worldId) 복합 FK — Prisma 스키마에 선언
-- 2) nullable·SetNull 참조와 사용자 범위 참조: 아래 트리거 (Prisma는 트리거를 관리하지 않으므로 drift 없음)

-- DropForeignKey
ALTER TABLE "CharacterMemory" DROP CONSTRAINT "CharacterMemory_ownerCharacterId_fkey";

-- DropForeignKey
ALTER TABLE "EmotionChange" DROP CONSTRAINT "EmotionChange_characterId_fkey";

-- DropForeignKey
ALTER TABLE "EmotionState" DROP CONSTRAINT "EmotionState_characterId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_sceneId_fkey";

-- DropForeignKey
ALTER TABLE "RelationshipBaseline" DROP CONSTRAINT "RelationshipBaseline_fromCharacterId_fkey";

-- DropForeignKey
ALTER TABLE "RelationshipBaseline" DROP CONSTRAINT "RelationshipBaseline_toCharacterId_fkey";

-- DropForeignKey
ALTER TABLE "RelationshipChange" DROP CONSTRAINT "RelationshipChange_relationshipStateId_fkey";

-- DropForeignKey
ALTER TABLE "RelationshipState" DROP CONSTRAINT "RelationshipState_fromCharacterId_fkey";

-- DropForeignKey
ALTER TABLE "RelationshipState" DROP CONSTRAINT "RelationshipState_toCharacterId_fkey";

-- DropForeignKey
ALTER TABLE "SceneParticipant" DROP CONSTRAINT "SceneParticipant_characterId_fkey";

-- DropForeignKey
ALTER TABLE "SceneParticipant" DROP CONSTRAINT "SceneParticipant_sceneId_fkey";

-- AlterTable: 기존 행이 있어도 안전하도록 nullable 추가 → 장면의 worldId로 채움 → NOT NULL
ALTER TABLE "SceneParticipant" ADD COLUMN "worldId" TEXT;
UPDATE "SceneParticipant" sp SET "worldId" = cs."worldId" FROM "ConversationScene" cs WHERE cs.id = sp."sceneId";
ALTER TABLE "SceneParticipant" ALTER COLUMN "worldId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Character_id_worldId_key" ON "Character"("id", "worldId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationScene_id_worldId_key" ON "ConversationScene"("id", "worldId");

-- CreateIndex
CREATE UNIQUE INDEX "EmotionState_characterId_worldId_key" ON "EmotionState"("characterId", "worldId");

-- CreateIndex
CREATE UNIQUE INDEX "RelationshipState_id_worldId_key" ON "RelationshipState"("id", "worldId");

-- CreateIndex
CREATE INDEX "SseConnection_userId_idx" ON "SseConnection"("userId");

-- AddForeignKey
ALTER TABLE "RelationshipBaseline" ADD CONSTRAINT "RelationshipBaseline_fromCharacterId_worldId_fkey" FOREIGN KEY ("fromCharacterId", "worldId") REFERENCES "Character"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RelationshipBaseline" ADD CONSTRAINT "RelationshipBaseline_toCharacterId_worldId_fkey" FOREIGN KEY ("toCharacterId", "worldId") REFERENCES "Character"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SceneParticipant" ADD CONSTRAINT "SceneParticipant_sceneId_worldId_fkey" FOREIGN KEY ("sceneId", "worldId") REFERENCES "ConversationScene"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SceneParticipant" ADD CONSTRAINT "SceneParticipant_characterId_worldId_fkey" FOREIGN KEY ("characterId", "worldId") REFERENCES "Character"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SceneParticipant" ADD CONSTRAINT "SceneParticipant_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_sceneId_worldId_fkey" FOREIGN KEY ("sceneId", "worldId") REFERENCES "ConversationScene"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RelationshipState" ADD CONSTRAINT "RelationshipState_fromCharacterId_worldId_fkey" FOREIGN KEY ("fromCharacterId", "worldId") REFERENCES "Character"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RelationshipState" ADD CONSTRAINT "RelationshipState_toCharacterId_worldId_fkey" FOREIGN KEY ("toCharacterId", "worldId") REFERENCES "Character"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RelationshipChange" ADD CONSTRAINT "RelationshipChange_relationshipStateId_worldId_fkey" FOREIGN KEY ("relationshipStateId", "worldId") REFERENCES "RelationshipState"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmotionState" ADD CONSTRAINT "EmotionState_characterId_worldId_fkey" FOREIGN KEY ("characterId", "worldId") REFERENCES "Character"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmotionChange" ADD CONSTRAINT "EmotionChange_characterId_worldId_fkey" FOREIGN KEY ("characterId", "worldId") REFERENCES "Character"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CharacterMemory" ADD CONSTRAINT "CharacterMemory_ownerCharacterId_worldId_fkey" FOREIGN KEY ("ownerCharacterId", "worldId") REFERENCES "Character"("id", "worldId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SseConnection" ADD CONSTRAINT "SseConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────
-- 범위 일치 트리거
-- 복합 FK의 ON DELETE SET NULL은 worldId(NOT NULL)까지 비우려 하므로 쓸 수 없다.
-- 대신 INSERT·UPDATE 시 참조 대상의 범위 컬럼(worldId / ownerId / userId)이 자신과 같은지 검사한다.
-- 참조 대상이 없으면 통과시킨다 (존재 여부는 FK가 검사).
-- 전제: worldId·ownerId·userId는 생성 후 바뀌지 않는다 (앱 규칙, database.md §4.3).
-- ─────────────────────────────────────────────

CREATE FUNCTION enforce_same_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ref_table text := TG_ARGV[0];
  fk_col    text := TG_ARGV[1];
  ref_scope text := TG_ARGV[2];
  own_scope text := TG_ARGV[3];
  ref_id    text := to_jsonb(NEW) ->> fk_col;
  expected  text := to_jsonb(NEW) ->> own_scope;
  actual    text;
BEGIN
  IF ref_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT %I FROM %I WHERE id = $1', ref_scope, ref_table) INTO actual USING ref_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION '% violates scope: %.% must reference % with the same %', TG_NAME, TG_TABLE_NAME, fk_col, ref_table, ref_scope
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- 같은 세계관 (nullable · ON DELETE SET NULL 참조)
CREATE TRIGGER message_speaker_same_world BEFORE INSERT OR UPDATE OF "speakerCharacterId", "worldId" ON "Message"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('Character', 'speakerCharacterId', 'worldId', 'worldId');
CREATE TRIGGER memory_about_same_world BEFORE INSERT OR UPDATE OF "aboutCharacterId", "worldId" ON "CharacterMemory"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('Character', 'aboutCharacterId', 'worldId', 'worldId');
CREATE TRIGGER memory_source_scene_same_world BEFORE INSERT OR UPDATE OF "sourceSceneId", "worldId" ON "CharacterMemory"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('ConversationScene', 'sourceSceneId', 'worldId', 'worldId');
CREATE TRIGGER relationship_change_scene_same_world BEFORE INSERT OR UPDATE OF "sceneId", "worldId" ON "RelationshipChange"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('ConversationScene', 'sceneId', 'worldId', 'worldId');
CREATE TRIGGER emotion_change_scene_same_world BEFORE INSERT OR UPDATE OF "sceneId", "worldId" ON "EmotionChange"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('ConversationScene', 'sceneId', 'worldId', 'worldId');
CREATE TRIGGER world_event_source_scene_same_world BEFORE INSERT OR UPDATE OF "sourceSceneId", "worldId" ON "WorldEvent"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('ConversationScene', 'sourceSceneId', 'worldId', 'worldId');
CREATE TRIGGER scene_run_same_world BEFORE INSERT OR UPDATE OF "runId", "worldId" ON "ConversationScene"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('SimulationRun', 'runId', 'worldId', 'worldId');
CREATE TRIGGER save_snapshot_same_world BEFORE INSERT OR UPDATE OF "snapshotId", "worldId" ON "SaveGame"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('GameSnapshot', 'snapshotId', 'worldId', 'worldId');

-- 같은 사용자 (세계관 소유자 · 키 연결 소유자)
CREATE TRIGGER sse_connection_world_owner BEFORE INSERT OR UPDATE OF "worldId", "userId" ON "SseConnection"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('World', 'worldId', 'ownerId', 'userId');
CREATE TRIGGER api_log_world_owner BEFORE INSERT OR UPDATE OF "worldId", "userId" ON "ApiRequestLog"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('World', 'worldId', 'ownerId', 'userId');
CREATE TRIGGER api_log_connection_owner BEFORE INSERT OR UPDATE OF "connectionId", "userId" ON "ApiRequestLog"
  FOR EACH ROW EXECUTE FUNCTION enforce_same_scope('AiProviderConnection', 'connectionId', 'userId', 'userId');
