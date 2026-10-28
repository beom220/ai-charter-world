import { randomUUID } from "node:crypto";
import { SCENE_GENERATION_TIMEOUT_MS, SCENE_IN_FLIGHT_STALE_MS, SCENE_MAX_OUTPUT_TOKENS, SCENE_HISTORY_PAGE_SIZE, SCENE_PARTICIPANTS_MIN, SCENE_RECENT_HISTORY_SCENES, SCENE_TEMPERATURE } from "../../../../config/limits";
import { getProviderKeyMaterial, type ProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { buildStoryPrompt, type PromptCharacter, type PromptHistoryScene } from "@/server/engine/context/story-prompt";
import { selectSceneParticipants } from "@/server/engine/director/select-participants";
import { createUsageMeter } from "@/server/engine/usage/usage-guard";
import { parseSceneOutput, SCENE_ALIASES, sceneResponseJsonSchema, SceneValidationError } from "@/server/engine/validation/scene-output";
import { settlePausing } from "@/server/domain/simulation/control";
import { notifyWorld, publishEvents } from "@/server/events/event-bus";
import { getGeminiKeyClient } from "@/server/llm";
import { GeminiCallError, type GeminiKeyClient, type GeminiRequestMeter } from "@/server/llm/gemini/client";
import { logServerError } from "@/server/logging/log";
import { AppError, ConflictError, NotFoundError } from "@/server/domain/errors";
import type { AuthenticatedUserId } from "@/server/domain/identity";
import { GeminiRequestError, loadKey, requireUsableGeminiConnection } from "@/server/domain/providers/gemini-verification";

// 수동 대화 장면 1개 생성 (Phase 5-1 Vertical Slice, architecture.md §6.3~§6.7의 축소판). 런타임 독립.
// 수동 생성(generateScene)은 버튼을 누를 때만 Gemini를 1회 호출한다. 자동 실행 Runner(engine/runner, Phase 5-4-2)는
// 같은 prepareScene·runSceneAttempt를 쓰고 점유·해제·다음 예약만 따로 한다. 감정/관계/기억 반영은 없다.
//   1) 소유권 확인, 활성 캐릭터 중 참가자 2~3명 자동 선정(selectSceneParticipants), 연결(ACTIVE + 모델) 확인 — 외부 호출 없음
//   2) SimulationRuntime.inFlightAttemptId로 세계관당 동시 생성 1건만 허용 (중복 클릭으로 인한 이중 과금 방지)
//   2-1) 같은 세계관의 최근 완료 장면(최대 SCENE_RECENT_HISTORY_SCENES개)을 오래된 것부터 프롬프트에 넣는다 (Phase 5-2)
//   3) UsageGuard meter를 거쳐 generateContent 1회 (자동 재시도 없음)
//   4) Zod·별칭 검증 → 실패하면 아무것도 저장하지 않는다
//   5) GameState 행 잠금 + stateVersion 펜싱 + attemptId UNIQUE로 단일 트랜잭션 커밋 (§6.7)
//   6) 같은 트랜잭션에서 outbox에 scene.committed를 기록하고, 커밋 후 SSE 구독자에게 알린다 (Phase 5-3, §10.3)

export type SceneDeps = { client?: GeminiKeyClient; material?: ProviderKeyMaterial; now?: () => Date; random?: () => number };

export type SceneMessageView = {
  id: string;
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
    select: { id: true, turnIndex: true, speakerCharacterId: true, speakerNameSnapshot: true, dialogue: true, actionIntent: true, emotionCue: true },
  },
} as const;

type SceneRow = Omit<SceneView, "messages"> & { messages: (Omit<SceneMessageView, "speakerName"> & { speakerNameSnapshot: string })[] };

const toView = (row: SceneRow): SceneView => ({
  ...row,
  messages: row.messages.map(({ speakerNameSnapshot, ...m }) => ({ ...m, speakerName: speakerNameSnapshot })),
});

/**
 * 대화 기록 한 페이지 (새 것부터). `beforeSeq`를 주면 그보다 오래된 장면만 준다.
 * seq는 세계관 안에서 UNIQUE이므로 seq 커서로 이어 받으면 중복·누락이 없다. 세계관이 없거나 타인 소유면 404
 */
export async function listScenes(
  userId: AuthenticatedUserId,
  worldId: string,
  { beforeSeq, take = SCENE_HISTORY_PAGE_SIZE }: { beforeSeq?: number; take?: number } = {},
): Promise<{ scenes: SceneView[]; hasMore: boolean }> {
  const world = await prisma.world.findFirst({ where: { id: worldId, ownerId: userId }, select: { id: true } });
  if (!world) throw new NotFoundError();
  const rows = await prisma.conversationScene.findMany({
    where: { worldId, ...(beforeSeq === undefined ? {} : { seq: { lt: beforeSeq } }) },
    orderBy: { seq: "desc" },
    take: take + 1,
    select: sceneSelect,
  });
  return { scenes: rows.slice(0, take).map(toView), hasMore: rows.length > take };
}

/** 프롬프트용 최근 완료 장면 (오래된 것 → 최신). 커밋된 장면만 저장되므로 저장된 장면 = 완료 장면 */
async function loadRecentHistory(userId: AuthenticatedUserId, worldId: string): Promise<PromptHistoryScene[]> {
  const rows = await prisma.conversationScene.findMany({
    where: { worldId, world: { ownerId: userId } },
    orderBy: { seq: "desc" },
    take: SCENE_RECENT_HISTORY_SCENES,
    select: {
      seq: true,
      title: true,
      summary: true,
      participants: { select: { nameSnapshot: true, alias: true }, orderBy: { alias: "asc" } },
      messages: { orderBy: { turnIndex: "asc" }, select: { speakerNameSnapshot: true, dialogue: true, actionIntent: true } },
    },
  });
  return rows.reverse().map((r) => ({
    seq: r.seq,
    title: r.title,
    summary: r.summary,
    participants: r.participants.map((p) => p.nameSnapshot),
    turns: r.messages.map((m) => ({ speaker: m.speakerNameSnapshot, dialogue: m.dialogue, actionIntent: m.actionIntent })),
  }));
}

/** 장면 1회 시도 맥락 (수동 생성·Runner 공용). 점유(inFlightAttemptId)와 해제는 호출자가 한다 */
export type SceneAttempt = {
  attemptId: string;
  /** Runner 실행이면 Run과 lease 소유자. 커밋 때 runtime의 현재 Run·lease·진행 중 시도와 같아야 한다 (§6.7) */
  runner?: { runId: string; leaseOwner: string };
  /** Gemini 요청 예약 직전에 호출한다. throw하면 요청을 보내지 않는다 (Runner의 호출 직전 재검증) */
  beforeRequest?: () => Promise<void>;
};

type PreparedScene = Awaited<ReturnType<typeof prepareScene>>;

/** 1) 소유권·참가자·연결 확인과 키 로드 (외부 호출 없음) */
export async function prepareScene(userId: AuthenticatedUserId, worldId: string, deps: SceneDeps = {}) {
  // 1) 소유권·참가자·연결 확인 (외부 호출 전)
  const world = await prisma.world.findFirst({
    where: { id: worldId, ownerId: userId },
    select: { name: true, worldRules: true, currentSituation: true, worldContext: true, gameState: { select: { maxTurnsPerScene: true } } },
  });
  if (!world?.gameState) throw new NotFoundError();
  // 참가자는 서버가 정한다. 삭제된 캐릭터는 후보에서 제외한다
  const active = await prisma.character.findMany({
    where: { worldId, deletedAt: null, world: { ownerId: userId } },
    orderBy: { createdAt: "asc" },
    include: { emotionState: { select: { mood: true, intensity: true } } },
  });
  const rows = selectSceneParticipants(active, deps.random);
  if (!rows) throw new ConflictError("NOT_ENOUGH_CHARACTERS", `대화하려면 활성 캐릭터가 ${SCENE_PARTICIPANTS_MIN}명 이상 필요합니다.`);
  const characterIds = rows.map((r) => r.id);
  const characters: (PromptCharacter & { id: string })[] = rows.map((r, i) => {
    return {
      id: r.id,
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
  return { world, characters, characterIds, modelId, key };
}

export async function generateScene(userId: AuthenticatedUserId, worldId: string, deps: SceneDeps = {}): Promise<SceneView> {
  const now = deps.now ?? (() => new Date());
  const prepared = await prepareScene(userId, worldId, deps);

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
    return await runSceneAttempt(userId, worldId, prepared, { attemptId }, deps);
  } finally {
    await prisma.simulationRuntime
      .updateMany({ where: { worldId, inFlightAttemptId: attemptId }, data: { inFlightAttemptId: null, inFlightStartedAt: null } })
      .catch((e: unknown) => logServerError("scene.release", e));
    await settlePausing(worldId); // 진행 중 장면 때문에 PAUSING이었으면 PAUSED로 마무리
  }
}

/** 2-1)~6) 점유된 시도 1건: 프롬프트 → Gemini 1회 → 검증 → 펜싱 커밋 + outbox → 알림 */
export async function runSceneAttempt(
  userId: AuthenticatedUserId,
  worldId: string,
  { world, characters, characterIds, modelId, key }: PreparedScene,
  attempt: SceneAttempt,
  deps: SceneDeps = {},
): Promise<SceneView> {
  const now = deps.now ?? (() => new Date());
  const { attemptId } = attempt;
  const expected = await prisma.gameState.findUniqueOrThrow({ where: { worldId }, select: { stateVersion: true, maxTurnsPerScene: true } });
  const maxTurns = expected.maxTurnsPerScene;
  const aliases = characters.map((c) => c.alias);
  const prompt = buildStoryPrompt(world, characters, maxTurns, await loadRecentHistory(userId, worldId));

  // 3) UsageGuard를 거친 Gemini 호출 1회
  const usageMeter = createUsageMeter(
    { userId, connectionId: key.connectionId, keyFingerprint: key.fingerprint },
    { kind: "SIMULATION", worldId, runId: attempt.runner?.runId ?? null, attemptId, callIndex: 0 },
    { now: deps.now },
  );
  const { beforeRequest } = attempt;
  const meter: GeminiRequestMeter = beforeRequest
    ? async (request) => {
        await beforeRequest();
        return usageMeter(request);
      }
    : usageMeter;
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
  const committed = await prisma.$transaction(async (tx) => {
    // 잠금 순서 World → GameState → Runtime (제어 명령과 같음). 장면·outbox INSERT가 World에 FK 잠금을 걸므로 World를 먼저 잡는다
    await tx.$queryRaw`SELECT 1 FROM "World" WHERE "id" = ${worldId} FOR UPDATE`;
    await tx.$queryRaw`SELECT 1 FROM "GameState" WHERE "worldId" = ${worldId} FOR UPDATE`;
    const gs = await tx.gameState.findUnique({ where: { worldId } });
    if (!gs || gs.stateVersion !== expected.stateVersion) {
      throw new ConflictError("SCENE_STALE", "생성하는 동안 게임 상태가 바뀌어 이번 장면을 저장하지 않았습니다.");
    }
    if (attempt.runner) {
      // Runner 시도: 같은 Run·lease 소유자·진행 중 시도일 때만 커밋한다
      await tx.$queryRaw`SELECT 1 FROM "SimulationRuntime" WHERE "worldId" = ${worldId} FOR UPDATE`;
      const rt = await tx.simulationRuntime.findUnique({ where: { worldId }, select: { currentRunId: true, leaseOwner: true, inFlightAttemptId: true } });
      if (!rt || rt.currentRunId !== attempt.runner.runId || rt.leaseOwner !== attempt.runner.leaseOwner || rt.inFlightAttemptId !== attemptId) {
        throw new ConflictError("SCENE_STALE", "생성하는 동안 실행 상태가 바뀌어 이번 장면을 저장하지 않았습니다.");
      }
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
        runId: attempt.runner?.runId ?? null,
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

    // 검증·저장된 내용만 이벤트로 보낸다 (프롬프트·키·응답 원문 없음)
    const view = toView(await tx.conversationScene.findUniqueOrThrow({ where: { id: scene.id }, select: sceneSelect }));
    await publishEvents(tx, worldId, [{ type: "scene.committed", payload: { scene: JSON.parse(JSON.stringify(view)) } }]);
    return view;
  });

  notifyWorld(worldId);
  return committed;
}
