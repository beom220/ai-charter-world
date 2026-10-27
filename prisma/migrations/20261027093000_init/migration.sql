-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('GEMINI');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('UNVERIFIED', 'ACTIVE', 'INVALID');

-- CreateEnum
CREATE TYPE "WorldVisibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'NONBINARY', 'CUSTOM', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "Mood" AS ENUM ('NEUTRAL', 'HAPPY', 'EXCITED', 'CALM', 'SAD', 'ANXIOUS', 'ANGRY', 'FEARFUL', 'EMBARRASSED', 'LONELY', 'HOPEFUL', 'TIRED');

-- CreateEnum
CREATE TYPE "IntervalPreset" AS ENUM ('SLOW', 'NORMAL', 'FAST');

-- CreateEnum
CREATE TYPE "StrategyMode" AS ENUM ('STORY', 'AGENT');

-- CreateEnum
CREATE TYPE "MotiveType" AS ENUM ('WORLD_EVENT', 'RELATIONSHIP', 'GOAL', 'MIXED');

-- CreateEnum
CREATE TYPE "SceneEndReason" AS ENUM ('RESOLVED', 'INTERRUPTED', 'STALEMATE', 'TURN_LIMIT');

-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('EVENT', 'PROMISE', 'CONFESSION', 'CONFLICT', 'SECRET', 'IMPRESSION', 'OTHER');

-- CreateEnum
CREATE TYPE "MemoryAcquisition" AS ENUM ('WITNESSED', 'TOLD', 'OBSERVED');

-- CreateEnum
CREATE TYPE "WorldEventKind" AS ENUM ('INITIAL_SITUATION', 'SCENE_OUTCOME', 'USER_INTERVENTION');

-- CreateEnum
CREATE TYPE "EventVisibility" AS ENUM ('PUBLIC', 'PARTICIPANTS');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "RuntimeStatus" AS ENUM ('IDLE', 'RUNNING', 'PAUSING', 'PAUSED');

-- CreateEnum
CREATE TYPE "StatusReason" AS ENUM ('USER', 'CLIENT_DISCONNECTED', 'USAGE_LIMIT', 'KEY_INVALID', 'LOADED', 'RESET', 'SERVER_RECOVERY');

-- CreateEnum
CREATE TYPE "ApiOutcome" AS ENUM ('SUCCESS', 'HTTP_ERROR', 'NETWORK_ERROR', 'VALIDATION_ERROR', 'ABORTED');

-- CreateEnum
CREATE TYPE "SaveKind" AS ENUM ('MANUAL', 'AUTO');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProviderConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL DEFAULT 'GEMINI',
    "encryptedKey" BYTEA NOT NULL,
    "keyIv" BYTEA NOT NULL,
    "keyAuthTag" BYTEA NOT NULL,
    "encryptionKeyVersion" INTEGER NOT NULL,
    "keyLast4" VARCHAR(4) NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "defaultModel" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "lastVerifiedAt" TIMESTAMPTZ(3),
    "lastErrorCode" TEXT,
    "dailyRequestLimit" INTEGER,
    "dailyTokenLimit" INTEGER,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "backoffLevel" INTEGER NOT NULL DEFAULT 0,
    "blockedUntil" TIMESTAMPTZ(3),
    "blockReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiUsageDaily" (
    "connectionId" TEXT NOT NULL,
    "usageDate" DATE NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "thoughtTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMicros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ApiUsageDaily_pkey" PRIMARY KEY ("connectionId","usageDate")
);

-- CreateTable
CREATE TABLE "World" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "summary" TEXT,
    "eraAndPlace" TEXT,
    "worldRules" TEXT,
    "currentSituation" TEXT,
    "worldContext" TEXT NOT NULL DEFAULT '',
    "visibility" "WorldVisibility" NOT NULL DEFAULT 'PRIVATE',
    "templateKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "World_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "gender" "Gender" NOT NULL DEFAULT 'UNSPECIFIED',
    "genderCustom" VARCHAR(30),
    "age" INTEGER,
    "personalityTags" TEXT[],
    "extraversion" INTEGER NOT NULL,
    "agreeableness" INTEGER NOT NULL,
    "conscientiousness" INTEGER NOT NULL,
    "emotionalStability" INTEGER NOT NULL,
    "openness" INTEGER NOT NULL,
    "goal" TEXT,
    "characterContext" VARCHAR(300) NOT NULL DEFAULT '',
    "initialMood" "Mood" NOT NULL DEFAULT 'NEUTRAL',
    "initialMoodIntensity" INTEGER NOT NULL DEFAULT 50,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelationshipBaseline" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "fromCharacterId" TEXT NOT NULL,
    "toCharacterId" TEXT NOT NULL,
    "affinity" INTEGER NOT NULL DEFAULT 0,
    "trust" INTEGER NOT NULL DEFAULT 0,
    "respect" INTEGER NOT NULL DEFAULT 0,
    "familiarity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RelationshipBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameState" (
    "worldId" TEXT NOT NULL,
    "stateVersion" INTEGER NOT NULL DEFAULT 0,
    "changeSeq" INTEGER NOT NULL DEFAULT 0,
    "nextSceneSeq" INTEGER NOT NULL DEFAULT 1,
    "strategyMode" "StrategyMode" NOT NULL DEFAULT 'STORY',
    "intervalPreset" "IntervalPreset" NOT NULL DEFAULT 'NORMAL',
    "maxTurnsPerScene" INTEGER NOT NULL DEFAULT 6,
    "participantsMin" INTEGER NOT NULL DEFAULT 2,
    "participantsMax" INTEGER NOT NULL DEFAULT 3,
    "modelOverride" TEXT,
    "lastCommittedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GameState_pkey" PRIMARY KEY ("worldId")
);

-- CreateTable
CREATE TABLE "ConversationScene" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "attemptId" TEXT NOT NULL,
    "runId" TEXT,
    "strategyMode" "StrategyMode" NOT NULL,
    "model" TEXT NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "summary" TEXT NOT NULL,
    "motiveType" "MotiveType" NOT NULL,
    "motiveRef" TEXT,
    "endReason" "SceneEndReason" NOT NULL,
    "contextTruncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SceneParticipant" (
    "sceneId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "alias" VARCHAR(3) NOT NULL,
    "nameSnapshot" VARCHAR(50) NOT NULL,

    CONSTRAINT "SceneParticipant_pkey" PRIMARY KEY ("sceneId","characterId")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "turnIndex" INTEGER NOT NULL,
    "speakerCharacterId" TEXT,
    "speakerNameSnapshot" VARCHAR(50) NOT NULL,
    "dialogue" TEXT NOT NULL,
    "actionIntent" TEXT,
    "emotionCue" VARCHAR(40),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelationshipState" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "fromCharacterId" TEXT NOT NULL,
    "toCharacterId" TEXT NOT NULL,
    "affinity" INTEGER NOT NULL,
    "trust" INTEGER NOT NULL,
    "respect" INTEGER NOT NULL,
    "familiarity" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RelationshipState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelationshipChange" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "relationshipStateId" TEXT NOT NULL,
    "sceneId" TEXT,
    "dAffinity" INTEGER NOT NULL,
    "dTrust" INTEGER NOT NULL,
    "dRespect" INTEGER NOT NULL,
    "dFamiliarity" INTEGER NOT NULL,
    "proposed" JSONB NOT NULL,
    "clamped" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelationshipChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmotionState" (
    "characterId" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "mood" "Mood" NOT NULL,
    "intensity" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmotionState_pkey" PRIMARY KEY ("characterId")
);

-- CreateTable
CREATE TABLE "EmotionChange" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "sceneId" TEXT,
    "fromMood" "Mood" NOT NULL,
    "toMood" "Mood" NOT NULL,
    "dIntensity" INTEGER NOT NULL,
    "proposedDelta" INTEGER NOT NULL,
    "clamped" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmotionChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CharacterMemory" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "ownerCharacterId" TEXT NOT NULL,
    "aboutCharacterId" TEXT,
    "kind" "MemoryKind" NOT NULL,
    "acquisition" "MemoryAcquisition" NOT NULL DEFAULT 'WITNESSED',
    "content" TEXT NOT NULL,
    "importance" INTEGER NOT NULL,
    "sourceSceneId" TEXT,
    "shareGroupId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CharacterMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorldEvent" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "kind" "WorldEventKind" NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "visibility" "EventVisibility" NOT NULL DEFAULT 'PUBLIC',
    "status" "EventStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceSceneId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WorldEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationRuntime" (
    "worldId" TEXT NOT NULL,
    "status" "RuntimeStatus" NOT NULL DEFAULT 'IDLE',
    "statusReason" "StatusReason",
    "currentRunId" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "inFlightAttemptId" TEXT,
    "inFlightStartedAt" TIMESTAMPTZ(3),
    "clientHoldSince" TIMESTAMPTZ(3),
    "nextSceneAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SimulationRuntime_pkey" PRIMARY KEY ("worldId")
);

-- CreateTable
CREATE TABLE "SseConnection" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "connectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SseConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationRun" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "endReason" TEXT,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "thoughtTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMicros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "SimulationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT,
    "worldId" TEXT,
    "runId" TEXT,
    "attemptId" TEXT,
    "callIndex" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "latencyMs" INTEGER,
    "httpStatus" INTEGER,
    "outcome" "ApiOutcome" NOT NULL,
    "errorCode" TEXT,
    "errorMessage" VARCHAR(500),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "thoughtTokens" INTEGER,
    "estimatedCostMicros" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemNotice" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "runId" TEXT,
    "attemptId" TEXT,
    "code" TEXT NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationEvent" (
    "id" BIGSERIAL NOT NULL,
    "worldId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaveGame" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "kind" "SaveKind" NOT NULL,
    "autoForWorldId" TEXT,
    "name" VARCHAR(60) NOT NULL,
    "snapshotId" TEXT,
    "sceneCount" INTEGER NOT NULL,
    "characterCount" INTEGER NOT NULL,
    "worldNameSnapshot" VARCHAR(100) NOT NULL,
    "stateVersionAtSave" INTEGER NOT NULL,
    "replacedAtChangeSeq" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SaveGame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameSnapshot" (
    "id" TEXT NOT NULL,
    "worldId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "AiProviderConnection_userId_key" ON "AiProviderConnection"("userId");

-- CreateIndex
CREATE INDEX "World_ownerId_updatedAt_idx" ON "World"("ownerId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Character_worldId_deletedAt_idx" ON "Character"("worldId", "deletedAt");

-- CreateIndex
CREATE INDEX "RelationshipBaseline_worldId_idx" ON "RelationshipBaseline"("worldId");

-- CreateIndex
CREATE UNIQUE INDEX "RelationshipBaseline_fromCharacterId_toCharacterId_key" ON "RelationshipBaseline"("fromCharacterId", "toCharacterId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationScene_attemptId_key" ON "ConversationScene"("attemptId");

-- CreateIndex
CREATE INDEX "ConversationScene_worldId_createdAt_idx" ON "ConversationScene"("worldId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationScene_worldId_seq_key" ON "ConversationScene"("worldId", "seq");

-- CreateIndex
CREATE INDEX "SceneParticipant_characterId_sceneId_idx" ON "SceneParticipant"("characterId", "sceneId");

-- CreateIndex
CREATE INDEX "Message_worldId_createdAt_idx" ON "Message"("worldId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_sceneId_turnIndex_key" ON "Message"("sceneId", "turnIndex");

-- CreateIndex
CREATE INDEX "RelationshipState_worldId_idx" ON "RelationshipState"("worldId");

-- CreateIndex
CREATE UNIQUE INDEX "RelationshipState_fromCharacterId_toCharacterId_key" ON "RelationshipState"("fromCharacterId", "toCharacterId");

-- CreateIndex
CREATE INDEX "RelationshipChange_relationshipStateId_createdAt_idx" ON "RelationshipChange"("relationshipStateId", "createdAt");

-- CreateIndex
CREATE INDEX "EmotionState_worldId_idx" ON "EmotionState"("worldId");

-- CreateIndex
CREATE INDEX "EmotionChange_characterId_createdAt_idx" ON "EmotionChange"("characterId", "createdAt");

-- CreateIndex
CREATE INDEX "CharacterMemory_ownerCharacterId_importance_createdAt_idx" ON "CharacterMemory"("ownerCharacterId", "importance" DESC, "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CharacterMemory_worldId_idx" ON "CharacterMemory"("worldId");

-- CreateIndex
CREATE INDEX "WorldEvent_worldId_status_idx" ON "WorldEvent"("worldId", "status");

-- CreateIndex
CREATE INDEX "SimulationRuntime_status_leaseExpiresAt_idx" ON "SimulationRuntime"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "SseConnection_worldId_lastSeenAt_idx" ON "SseConnection"("worldId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "SimulationRun_worldId_startedAt_idx" ON "SimulationRun"("worldId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "ApiRequestLog_worldId_createdAt_idx" ON "ApiRequestLog"("worldId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ApiRequestLog_createdAt_idx" ON "ApiRequestLog"("createdAt");

-- CreateIndex
CREATE INDEX "SystemNotice_worldId_createdAt_idx" ON "SystemNotice"("worldId", "createdAt");

-- CreateIndex
CREATE INDEX "SimulationEvent_worldId_id_idx" ON "SimulationEvent"("worldId", "id");

-- CreateIndex
CREATE INDEX "SimulationEvent_createdAt_idx" ON "SimulationEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SaveGame_autoForWorldId_key" ON "SaveGame"("autoForWorldId");

-- CreateIndex
CREATE UNIQUE INDEX "SaveGame_snapshotId_key" ON "SaveGame"("snapshotId");

-- CreateIndex
CREATE INDEX "SaveGame_worldId_kind_updatedAt_idx" ON "SaveGame"("worldId", "kind", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "GameSnapshot_worldId_idx" ON "GameSnapshot"("worldId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProviderConnection" ADD CONSTRAINT "AiProviderConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiUsageDaily" ADD CONSTRAINT "ApiUsageDaily_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AiProviderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "World" ADD CONSTRAINT "World_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipBaseline" ADD CONSTRAINT "RelationshipBaseline_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipBaseline" ADD CONSTRAINT "RelationshipBaseline_fromCharacterId_fkey" FOREIGN KEY ("fromCharacterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipBaseline" ADD CONSTRAINT "RelationshipBaseline_toCharacterId_fkey" FOREIGN KEY ("toCharacterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameState" ADD CONSTRAINT "GameState_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationScene" ADD CONSTRAINT "ConversationScene_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationScene" ADD CONSTRAINT "ConversationScene_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SimulationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneParticipant" ADD CONSTRAINT "SceneParticipant_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "ConversationScene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneParticipant" ADD CONSTRAINT "SceneParticipant_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "ConversationScene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_speakerCharacterId_fkey" FOREIGN KEY ("speakerCharacterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipState" ADD CONSTRAINT "RelationshipState_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipState" ADD CONSTRAINT "RelationshipState_fromCharacterId_fkey" FOREIGN KEY ("fromCharacterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipState" ADD CONSTRAINT "RelationshipState_toCharacterId_fkey" FOREIGN KEY ("toCharacterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipChange" ADD CONSTRAINT "RelationshipChange_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipChange" ADD CONSTRAINT "RelationshipChange_relationshipStateId_fkey" FOREIGN KEY ("relationshipStateId") REFERENCES "RelationshipState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipChange" ADD CONSTRAINT "RelationshipChange_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "ConversationScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmotionState" ADD CONSTRAINT "EmotionState_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmotionState" ADD CONSTRAINT "EmotionState_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmotionChange" ADD CONSTRAINT "EmotionChange_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmotionChange" ADD CONSTRAINT "EmotionChange_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmotionChange" ADD CONSTRAINT "EmotionChange_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "ConversationScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterMemory" ADD CONSTRAINT "CharacterMemory_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterMemory" ADD CONSTRAINT "CharacterMemory_ownerCharacterId_fkey" FOREIGN KEY ("ownerCharacterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterMemory" ADD CONSTRAINT "CharacterMemory_aboutCharacterId_fkey" FOREIGN KEY ("aboutCharacterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterMemory" ADD CONSTRAINT "CharacterMemory_sourceSceneId_fkey" FOREIGN KEY ("sourceSceneId") REFERENCES "ConversationScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorldEvent" ADD CONSTRAINT "WorldEvent_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorldEvent" ADD CONSTRAINT "WorldEvent_sourceSceneId_fkey" FOREIGN KEY ("sourceSceneId") REFERENCES "ConversationScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationRuntime" ADD CONSTRAINT "SimulationRuntime_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SseConnection" ADD CONSTRAINT "SseConnection_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AiProviderConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemNotice" ADD CONSTRAINT "SystemNotice_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationEvent" ADD CONSTRAINT "SimulationEvent_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaveGame" ADD CONSTRAINT "SaveGame_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaveGame" ADD CONSTRAINT "SaveGame_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "GameSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameSnapshot" ADD CONSTRAINT "GameSnapshot_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- CHECK 제약 (Prisma 스키마로 표현 불가, database.md §4.1)
-- 앱 검증·clamp가 1차 방어이며, 이 제약 위반은 곧 버그다.
-- ─────────────────────────────────────────────

ALTER TABLE "Character" ADD CONSTRAINT character_bigfive_range CHECK (
  extraversion BETWEEN 0 AND 100 AND agreeableness BETWEEN 0 AND 100 AND
  conscientiousness BETWEEN 0 AND 100 AND "emotionalStability" BETWEEN 0 AND 100 AND
  openness BETWEEN 0 AND 100 AND "initialMoodIntensity" BETWEEN 0 AND 100);
ALTER TABLE "Character" ADD CONSTRAINT character_age_range CHECK (age IS NULL OR age BETWEEN 0 AND 1000);

ALTER TABLE "RelationshipState" ADD CONSTRAINT rel_range CHECK (
  affinity BETWEEN -100 AND 100 AND trust BETWEEN -100 AND 100 AND
  respect BETWEEN -100 AND 100 AND familiarity BETWEEN 0 AND 100);
ALTER TABLE "RelationshipState" ADD CONSTRAINT rel_not_self CHECK ("fromCharacterId" <> "toCharacterId");

ALTER TABLE "RelationshipBaseline" ADD CONSTRAINT baseline_range CHECK (
  affinity BETWEEN -100 AND 100 AND trust BETWEEN -100 AND 100 AND
  respect BETWEEN -100 AND 100 AND familiarity BETWEEN 0 AND 100);
ALTER TABLE "RelationshipBaseline" ADD CONSTRAINT baseline_not_self CHECK ("fromCharacterId" <> "toCharacterId");

ALTER TABLE "EmotionState"     ADD CONSTRAINT emotion_range CHECK (intensity BETWEEN 0 AND 100);
ALTER TABLE "CharacterMemory"  ADD CONSTRAINT memory_importance CHECK (importance BETWEEN 1 AND 5);
ALTER TABLE "GameState"        ADD CONSTRAINT gs_turns CHECK ("maxTurnsPerScene" BETWEEN 3 AND 6
                                 AND "participantsMin" >= 2 AND "participantsMax" BETWEEN "participantsMin" AND 6);
ALTER TABLE "SaveGame"         ADD CONSTRAINT save_kind_consistency CHECK (
  (kind = 'MANUAL' AND "autoForWorldId" IS NULL AND "snapshotId" IS NOT NULL) OR
  (kind = 'AUTO'   AND "autoForWorldId" = "worldId"));
