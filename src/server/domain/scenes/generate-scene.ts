import { randomUUID } from "node:crypto";
import { SCENE_GENERATION_TIMEOUT_MS, SCENE_IN_FLIGHT_STALE_MS, SCENE_MAX_OUTPUT_TOKENS, SCENE_TEMPERATURE } from "../../../../config/limits";
import { getProviderKeyMaterial, type ProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { buildStoryPrompt, type PromptCharacter } from "@/server/engine/context/story-prompt";
import { createUsageMeter } from "@/server/engine/usage/usage-guard";
import { parseSceneOutput, SCENE_ALIASES, sceneResponseJsonSchema, SceneValidationError } from "@/server/engine/validation/scene-output";
import { getGeminiKeyClient } from "@/server/llm";
import { GeminiCallError, type GeminiKeyClient } from "@/server/llm/gemini/client";
import { logServerError } from "@/server/logging/log";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "@/server/domain/errors";
import type { AuthenticatedUserId } from "@/server/domain/identity";
import { GeminiRequestError, loadKey, requireUsableGeminiConnection } from "@/server/domain/providers/gemini-verification";

// 수동 대화 장면 1개 생성 (Phase 5-1 Vertical Slice, architecture.md §6.3~§6.7의 축소판). 런타임 독립.
// 사용자가 버튼을 누를 때만 Gemini를 1회 호출한다. Runner·자동 반복·SSE·감정/관계/기억 반영은 없다.
//   1) 소유권·참가자(활성, 같은 세계관, 2~3명)·연결(ACTIVE + 모델) 확인 — 외부 호출 없음
//   2) SimulationRuntime.inFlightAttemptId로 세계관당 동시 생성 1건만 허용 (중복 클릭으로 인한 이중 과금 방지)
//   3) UsageGuard meter를 거쳐 generateContent 1회 (자동 재시도 없음)
//   4) Zod·별칭 검증 → 실패하면 아무것도 저장하지 않는다
//   5) GameState 행 잠금 + stateVersion 펜싱 + attemptId UNIQUE로 단일 트랜잭션 커밋 (§6.7)

type Deps = { client?: GeminiKeyClient; material?: ProviderKeyMaterial; now?: () => Date };

export type SceneMessageView = {
  turnIndex: number;
  speakerCharacterId: string | null;
  speakerName: string;
  dialogue: string;
  actionIntent: string | null;
  emotionCue: string | null;
};

export type SceneView = {
  id: string;
  seq: number;
  title: string;
  summary: string;
  contextTruncated: boolean;
  createdAt: Date;
  messages: SceneMessageView[];
};

/** 응답이 검증을 통과하지 못함. 응답 원문은 저장·반환하지 않는다 */
export class SceneValidationFailedError extends AppError {
  constructor() {
    super(502, "SCENE_VALIDATION_FAILED", "AI 응답 형식이 올바르지 않아 장면을 저장하지 않았습니다. 다시 시도하거나 다른 모델을 선택하세요.");
  }
}

const sceneSelect = {
  id: true,
  seq: true,
  title: true,
  summary: true,
  contextTruncated: true,
  createdAt: true,
  messages: {
    orderBy: { turnIndex: "asc" },
    select: { turnIndex: true, speakerCharacterId: true, speakerNameSnapshot: true, dialogue: true, actionIntent: true, emotionCue: true },
  },
} as const;

type SceneRow = Omit<SceneView, "messages"> & { messages: (Omit<SceneMessageView, "speakerName"> & { speakerNameSnapshot: string })[] };

const toView = (row: SceneRow): SceneView => ({
  ...row,
  messages: row.messages.map(({ speakerNameSnapshot, ...m }) => ({ ...m, speakerName: speakerNameSnapshot })),
});

/** 최근 장면 (새 것부터). 세계관이 없거나 타인 소유면 404 */
export async function listRecentScenes(userId: AuthenticatedUserId, worldId: string, take = 5): Promise<SceneView[]> {
  const world = await prisma.world.findFirst({ where: { id: worldId, ownerId: userId }, select: { id: true } });
  if (!world) throw new NotFoundError();
  const rows = await prisma.conversationScene.findMany({ where: { worldId }, orderBy: { seq: "desc" }, take, select: sceneSelect });
  return rows.map(toView);
}

export async function generateScene(userId: AuthenticatedUserId, worldId: string, characterIds: string[], deps: Deps = {}): Promise<SceneView> {
  const now = deps.now ?? (() => new Date());

  // 1) 소유권·참가자·연결 확인 (외부 호출 전)
  const world = await prisma.world.findFirst({
    where: { id: worldId, ownerId: userId },
    select: { name: true, worldRules: true, currentSituation: true, worldContext: true, gameState: { select: { maxTurnsPerScene: true } } },
  });
  if (!world?.gameState) throw new NotFoundError();
  const rows = await prisma.character.findMany({
    where: { id: { in: characterIds }, worldId, deletedAt: null, world: { ownerId: userId } },
    include: { emotionState: { select: { mood: true, intensity: true } } },
  });
  if (rows.length !== characterIds.length) throw new BadRequestError("선택한 캐릭터를 찾을 수 없거나 삭제되었습니다. 목록을 새로고침하세요.");
  const byId = new Map(rows.map((r) => [r.id, r]));
  const characters: (PromptCharacter & { id: string })[] = characterIds.map((id, i) => {
    const r = byId.get(id)!;
    return {
      id,
      alias: SCENE_ALIASES[i]!,
      name: r.name,
      gender: r.gender,
      genderCustom: r.genderCustom,
      age: r.age,
      personalityTags: r.personalityTags,
      bigFive: { extraversion: r.extraversion, agreeableness: r.agreeableness, conscientiousness: r.conscientiousness, emotionalStability: r.emotionalStability, openness: r.openness },
      goal: r.goal,
      characterContext: r.characterContext,
      mood: r.emotionState?.mood ?? null,
      moodIntensity: r.emotionState?.intensity ?? null,
    };
  });

  const { modelId } = await requireUsableGeminiConnection(userId);
  const key = await loadKey(userId, deps.material ?? getProviderKeyMaterial());

  // 2) 세계관당 진행 중 생성 1건 (실행 중인 시뮬레이션과도 겹치지 않게 IDLE·PAUSED에서만)
  const attemptId = randomUUID();
  const startedAt = now();
  const claimed = await prisma.simulationRuntime.updateMany({
    where: {
      worldId,
      status: { in: ["IDLE", "PAUSED"] },
      OR: [{ inFlightAttemptId: null }, { inFlightStartedAt: { lt: new Date(startedAt.getTime() - SCENE_IN_FLIGHT_STALE_MS) } }],
    },
    data: { inFlightAttemptId: attemptId, inFlightStartedAt: startedAt },
  });
  if (claimed.count === 0) throw new ConflictError("SCENE_IN_PROGRESS", "이 세계관에서 이미 장면을 생성하고 있습니다. 잠시 후 다시 시도하세요.");

  try {
    const expected = await prisma.gameState.findUniqueOrThrow({ where: { worldId }, select: { stateVersion: true, maxTurnsPerScene: true } });
    const maxTurns = expected.maxTurnsPerScene;
    const aliases = characters.map((c) => c.alias);
    const prompt = buildStoryPrompt(world, characters, maxTurns);

    // 3) UsageGuard를 거친 Gemini 호출 1회
    const meter = createUsageMeter(
      { userId, connectionId: key.connectionId, keyFingerprint: key.fingerprint },
      { kind: "SIMULATION", worldId, attemptId, callIndex: 0 },
      { now: deps.now },
    );
    let text: string;
    try {
      ({ text } = await (deps.client ?? getGeminiKeyClient()).generateJson(
        key.apiKey,
        {
          model: modelId,
          systemInstruction: prompt.systemInstruction,
          prompt: prompt.prompt,
          responseJsonSchema: sceneResponseJsonSchema(aliases, maxTurns),
          maxOutputTokens: SCENE_MAX_OUTPUT_TOKENS,
          temperature: SCENE_TEMPERATURE,
          timeoutMs: SCENE_GENERATION_TIMEOUT_MS,
        },
        meter,
      ));
    } catch (error) {
      if (error instanceof GeminiCallError) throw new GeminiRequestError(error.kind);
      throw error;
    }

    // 4) 검증. 실패하면 호출 기록만 VALIDATION_ERROR로 바꾸고 아무것도 저장하지 않는다
    let output;
    try {
      output = parseSceneOutput(text, aliases, maxTurns);
    } catch (error) {
      if (!(error instanceof SceneValidationError)) throw error;
      await prisma.apiRequestLog
        .updateMany({ where: { attemptId, userId, outcome: "SUCCESS" }, data: { outcome: "VALIDATION_ERROR", errorCode: `SCENE_${error.reason}` } })
        .catch((e: unknown) => logServerError("scene.validation-log", e));
      throw new SceneValidationFailedError();
    }

    // 5) 커밋
    const aliasMap = new Map(characters.map((c) => [c.alias, c]));
    const sceneId = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "GameState" WHERE "worldId" = ${worldId} FOR UPDATE`;
      const gs = await tx.gameState.findUnique({ where: { worldId } });
      if (!gs || gs.stateVersion !== expected.stateVersion) {
        throw new ConflictError("SCENE_STALE", "생성하는 동안 게임 상태가 바뀌어 이번 장면을 저장하지 않았습니다.");
      }
      const stillActive = await tx.character.count({ where: { id: { in: characterIds }, worldId, deletedAt: null } });
      if (stillActive !== characterIds.length) {
        throw new ConflictError("STALE_REFERENCE", "생성하는 동안 참가 캐릭터가 삭제되어 이번 장면을 저장하지 않았습니다.");
      }

      const scene = await tx.conversationScene.create({
        data: {
          worldId,
          seq: gs.nextSceneSeq,
          attemptId,
          strategyMode: "STORY",
          model: modelId,
          title: output.scene.title,
          summary: output.scene.summary,
          motiveType: "MIXED",
          endReason: output.scene.endReason,
          contextTruncated: prompt.contextTruncated,
        },
      });
      await tx.sceneParticipant.createMany({
        data: characters.map((c) => ({ sceneId: scene.id, characterId: c.id, worldId, alias: c.alias, nameSnapshot: c.name })),
      });
      await tx.message.createMany({
        data: output.turns.map((t, turnIndex) => {
          const speaker = aliasMap.get(t.speaker)!;
          return {
            sceneId: scene.id,
            worldId,
            turnIndex,
            speakerCharacterId: speaker.id,
            speakerNameSnapshot: speaker.name,
            dialogue: t.dialogue,
            actionIntent: t.actionIntent,
            emotionCue: t.emotionCue,
          };
        }),
      });
      const next = await tx.gameState.update({
        where: { worldId },
        data: { stateVersion: { increment: 1 }, changeSeq: { increment: 1 }, nextSceneSeq: { increment: 1 }, lastCommittedAt: now() },
      });

      // 자동저장은 LIVE로 두고 메타데이터만 갱신한다 (§9.3). 실체화된 복구 지점이 있으면 정리한다
      const auto = await tx.saveGame.findUnique({ where: { autoForWorldId: worldId }, select: { id: true, snapshotId: true } });
      if (auto) {
        await tx.saveGame.update({
          where: { id: auto.id },
          data: {
            snapshotId: null,
            replacedAtChangeSeq: null,
            sceneCount: await tx.conversationScene.count({ where: { worldId } }),
            characterCount: await tx.character.count({ where: { worldId, deletedAt: null } }),
            worldNameSnapshot: world.name,
            stateVersionAtSave: next.stateVersion,
          },
        });
        if (auto.snapshotId) await tx.gameSnapshot.delete({ where: { id: auto.snapshotId } });
      }
      return scene.id;
    });

    const row = await prisma.conversationScene.findUniqueOrThrow({ where: { id: sceneId }, select: sceneSelect });
    return toView(row);
  } finally {
    await prisma.simulationRuntime
      .updateMany({ where: { worldId, inFlightAttemptId: attemptId }, data: { inFlightAttemptId: null, inFlightStartedAt: null } })
      .catch((e: unknown) => logServerError("scene.release", e));
  }
}
