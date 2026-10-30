import { randomUUID } from "node:crypto";
import { SCENE_GENERATION_TIMEOUT_MS, SCENE_IN_FLIGHT_STALE_MS, SCENE_MAX_OUTPUT_TOKENS, SCENE_HISTORY_PAGE_SIZE, SCENE_PARTICIPANTS_MIN, SCENE_RECENT_HISTORY_SCENES, SCENE_TEMPERATURE } from "../../../../config/limits";
import { getProviderKeyMaterial, type ProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { findBackground } from "../../../../config/character-backgrounds";
import { buildStoryPrompt, type PromptBackground, type PromptCharacter, type PromptHistoryScene } from "@/server/engine/context/story-prompt";
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
import { applySceneProposals, loadParticipantContext } from "./scene-state";
import { applySceneWorld, claimAutoEvent, conditionPromptLines, countAlive, DEFAULT_CONDITION_STATE, loadPromptEvents, loadSceneNotes, type AutoEventClaim, type SceneNote } from "./scene-world";
import { settleWorldClock } from "@/server/domain/simulation/world-clock";
import { claimUserEvent, releaseUserEventClaim, type UserEventClaim } from "@/server/domain/events/user-events";
import { GeminiRequestError, loadKey, requireUsableGeminiConnection } from "@/server/domain/providers/gemini-verification";

// 수동 대화 장면 1개 생성 (Phase 5-1 Vertical Slice, architecture.md §6.3~§6.7의 축소판). 런타임 독립.
// 수동 생성(generateScene)은 버튼을 누를 때만 Gemini를 1회 호출한다. 자동 실행 Runner(engine/runner, Phase 5-4-2)는
// 같은 prepareScene·runSceneAttempt를 쓰고 점유·해제·다음 예약만 따로 한다.
//   1) 소유권 확인, 활성 캐릭터 중 참가자 2~3명 자동 선정(selectSceneParticipants), 연결(ACTIVE + 모델) 확인 — 외부 호출 없음
//   2) SimulationRuntime.inFlightAttemptId로 세계관당 동시 생성 1건만 허용 (중복 클릭으로 인한 이중 과금 방지)
//   2-1) 같은 세계관의 최근 완료 장면(최대 SCENE_RECENT_HISTORY_SCENES개)을 오래된 것부터 프롬프트에 넣는다 (Phase 5-2)
//   3) UsageGuard meter를 거쳐 generateContent 1회 (자동 재시도 없음)
//   4) Zod·별칭 검증 → 실패하면 아무것도 저장하지 않는다
//   5) GameState 행 잠금 + stateVersion 펜싱 + attemptId UNIQUE로 단일 트랜잭션 커밋 (§6.7).
//      장면·발언과 함께 감정·관계·기억 제안을 clamp해 반영한다(Phase 5-5, scene-state.ts). 세이브 슬롯은 바꾸지 않는다
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
  /** 커밋 때의 월드 시각 (7-2-2 이전 장면은 null) */
  worldSeconds: number | null;
  /** 사건 발생·해결, 신체 상태 변화 (캐릭터 발화와 분리된 시스템 정보) */
  notes: SceneNote[];
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
  worldSeconds: true,
  createdAt: true,
  messages: {
    orderBy: { turnIndex: "asc" },
    select: { id: true, turnIndex: true, speakerCharacterId: true, speakerNameSnapshot: true, dialogue: true, actionIntent: true, emotionCue: true },
  },
} as const;

type SceneRow = Omit<SceneView, "messages" | "notes"> & { messages: (Omit<SceneMessageView, "speakerName"> & { speakerNameSnapshot: string })[] };

const toView = (row: SceneRow, notes: SceneNote[] = []): SceneView => ({
  ...row,
  notes,
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
  const page = rows.slice(0, take);
  const notes = await loadSceneNotes(prisma, worldId, page);
  return { scenes: page.map((r) => toView(r, notes.get(r.id))), hasMore: rows.length > take };
}

/**
 * 프롬프트용 최근 완료 장면 (오래된 것 → 최신). 커밋된 장면만 저장되므로 저장된 장면 = 완료 장면.
 * settingsChangedAt보다 먼저 만든 장면은 "설정 변경 이전" 기록으로 표시한다 (과거 대화가 현재 설정을 덮어쓰지 않게)
 */
async function loadRecentHistory(userId: AuthenticatedUserId, worldId: string, settingsChangedAt: Date): Promise<PromptHistoryScene[]> {
  const rows = await prisma.conversationScene.findMany({
    where: { worldId, world: { ownerId: userId } },
    orderBy: { seq: "desc" },
    take: SCENE_RECENT_HISTORY_SCENES,
    select: {
      seq: true,
      title: true,
      summary: true,
      createdAt: true,
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
    beforeSettingsChange: r.createdAt < settingsChangedAt,
  }));
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * 설정 펜싱 (Runner·수동 생성 공용): 장면 준비 때 읽은 settingsSeq가 지금과 같은가. World 잠금을 잡은 트랜잭션에서 부른다.
 * settingsSeq는 세계관·캐릭터 설정 변경과 불러오기에서만 오른다. 실행 속도 변경·사건 등록(changeSeq만 증가)은 시도를 버리지 않는다.
 * 다르면 준비 이후 설정 수정·불러오기 등이 있었으므로 그 준비(이전 설정)로 호출·커밋하지 않는다.
 */
export async function settingsUnchanged(tx: Tx, worldId: string, settingsSeq: number): Promise<boolean> {
  const gs = await tx.gameState.findUnique({ where: { worldId }, select: { settingsSeq: true } });
  return gs?.settingsSeq === settingsSeq;
}

/** 준비 이후 설정이 바뀌어 장면을 만들지 않음 (수동 생성) */
const settingsChangedError = () => new ConflictError("SETTINGS_CHANGED", "장면을 준비하는 동안 설정이 바뀌어 이번 장면을 저장하지 않았습니다. 다시 시도하세요.");

/** 장면 1회 시도 맥락 (수동 생성·Runner 공용). 점유(inFlightAttemptId)와 해제는 호출자가 한다 */
export type SceneAttempt = {
  attemptId: string;
  /** Runner 실행이면 Run과 lease 소유자. 커밋 때 runtime의 현재 Run·lease·진행 중 시도와 같아야 한다 (§6.7) */
  runner?: { runId: string; leaseOwner: string };
  /** Gemini 요청 예약 직전에 호출한다. throw하면 요청을 보내지 않는다 (Runner의 호출 직전 재검증) */
  beforeRequest?: () => Promise<void>;
  /** 시도 기록 때 정한 자동 사건 (예약 장면이면). 커밋 트랜잭션에서 사건을 만들고 구간을 발생 처리한다 */
  autoEvent?: AutoEventClaim | null;
  /** 시도 기록 때 점유한 대기 사용자 사건 (7-2-3). 커밋 트랜잭션에서 점유가 그대로일 때만 ACTIVE로 바꾼다 */
  userEvent?: UserEventClaim | null;
  /**
   * 수동 생성: 커밋 때 settingsSeq가 준비 시점과 같아야 한다(IDLE에서는 호출 중에도 설정을 바꿀 수 있으므로).
   * Runner는 진행 중 시도가 있으면 설정 수정이 거부되므로 쓰지 않는다.
   */
  expectedSettingsSeq?: number;
};

type PreparedScene = Awaited<ReturnType<typeof prepareScene>>;

/** 1) 소유권·참가자·연결 확인과 키 로드 (외부 호출 없음) */
export async function prepareScene(userId: AuthenticatedUserId, worldId: string, deps: SceneDeps = {}) {
  // 1) 소유권·참가자·연결 확인 (외부 호출 전). 세계관·캐릭터 설정은 장면마다 DB에서 새로 읽는다(캐시 없음)
  const world = await prisma.world.findFirst({
    where: { id: worldId, ownerId: userId },
    select: {
      name: true,
      worldRules: true,
      currentSituation: true,
      worldContext: true,
      updatedAt: true,
      gameState: { select: { maxTurnsPerScene: true, settingsSeq: true, worldSeconds: true } },
    },
  });
  if (!world?.gameState) throw new NotFoundError();
  // 참가자는 서버가 정한다. 삭제된 캐릭터와 사망자는 후보에서 제외한다 (사망자는 발화·참가 불가, 슬롯만 차지)
  const active = await prisma.character.findMany({
    where: { worldId, deletedAt: null, world: { ownerId: userId }, OR: [{ condition: null }, { condition: { vital: "ALIVE" } }] },
    orderBy: { createdAt: "asc" },
    include: { emotionState: { select: { mood: true, intensity: true } }, condition: true },
  });
  const rows = selectSceneParticipants(active, deps.random);
  if (!rows) throw new ConflictError("NOT_ENOUGH_CHARACTERS", `대화하려면 대화할 수 있는 생존 캐릭터가 ${SCENE_PARTICIPANTS_MIN}명 이상 필요합니다.`);
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
      characterContext: r.characterContext,
      mood: r.emotionState?.mood ?? null,
      moodIntensity: r.emotionState?.intensity ?? null,
      backgrounds: promptBackgrounds(r.childhoodBackgroundId, r.adulthoodBackgroundId),
      condition: conditionPromptLines({ ...DEFAULT_CONDITION_STATE, ...(r.condition ?? {}) }, world.gameState!.worldSeconds),
    };
  });
  // 참가자 사이 관계와 각자의 기억 (Phase 5-5). 비참가자의 기억은 넣지 않는다
  const participantContext = await loadParticipantContext(userId, worldId, characters);
  for (const c of characters) Object.assign(c, participantContext.get(c.id));

  // 마지막 설정 변경 시각: 세계관 수정, 캐릭터 생성·수정·삭제(삭제된 캐릭터 포함) 중 가장 늦은 것
  const { _max } = await prisma.character.aggregate({ where: { worldId }, _max: { updatedAt: true } });
  const settingsChangedAt = _max.updatedAt && _max.updatedAt > world.updatedAt ? _max.updatedAt : world.updatedAt;

  const { modelId } = await requireUsableGeminiConnection(userId);
  const key = await loadKey(userId, deps.material ?? getProviderKeyMaterial());
  // settingsSeq: 시도를 기록·커밋할 때 준비 이후 설정이 바뀌지 않았는지 확인한다 (이전 설정으로 호출하지 않게)
  return { world, characters, characterIds, modelId, key, settingsChangedAt, settingsSeq: world.gameState.settingsSeq };
}

/** 배경 ID → 프롬프트용 이름·설명 (알 수 없는 ID·NULL은 넣지 않는다) */
function promptBackgrounds(childhoodId: string | null, adulthoodId: string | null): PromptBackground[] {
  const out: PromptBackground[] = [];
  const childhood = findBackground(childhoodId, "CHILDHOOD");
  const adulthood = findBackground(adulthoodId, "ADULTHOOD");
  if (childhood) out.push({ stage: "유년기", name: childhood.name, description: childhood.description });
  if (adulthood) out.push({ stage: "성년기", name: adulthood.name, description: adulthood.description });
  return out;
}

export async function generateScene(userId: AuthenticatedUserId, worldId: string, deps: SceneDeps = {}): Promise<SceneView> {
  const now = deps.now ?? (() => new Date());
  const prepared = await prepareScene(userId, worldId, deps);

  // 2) 세계관당 진행 중 생성 1건 (실행 중인 시뮬레이션과도 겹치지 않게 IDLE·PAUSED에서만).
  //    Runner의 시도 기록과 같이 World 잠금 아래에서 설정 펜싱(settingsSeq)을 확인한 뒤 점유한다 (잠금 순서 World → Runtime)
  const attemptId = randomUUID();
  const startedAt = now();
  const claims = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "World" WHERE "id" = ${worldId} FOR UPDATE`;
    if (!(await settingsUnchanged(tx, worldId, prepared.settingsSeq))) throw settingsChangedError();
    const claimed = await tx.simulationRuntime.updateMany({
      where: {
        worldId,
        status: { in: ["IDLE", "PAUSED"] },
        OR: [{ inFlightAttemptId: null }, { inFlightStartedAt: { lt: new Date(startedAt.getTime() - SCENE_IN_FLIGHT_STALE_MS) } }],
      },
      data: { inFlightAttemptId: attemptId, inFlightStartedAt: startedAt },
    });
    if (claimed.count === 0) throw new ConflictError("SCENE_IN_PROGRESS", "이 세계관에서 이미 장면을 생성하고 있습니다. 잠시 후 다시 시도하세요.");
    // 자동 사건 구간 판정 (Runner와 같은 영속 규칙)과 가장 오래된 대기 사용자 사건 점유
    return { autoEvent: await claimAutoEvent(tx, worldId, deps.random ?? Math.random), userEvent: await claimUserEvent(tx, worldId, attemptId) };
  });

  try {
    return await runSceneAttempt(userId, worldId, prepared, { attemptId, expectedSettingsSeq: prepared.settingsSeq, ...claims }, deps);
  } finally {
    await releaseUserEventClaim(prisma, worldId, attemptId).catch((e: unknown) => logServerError("scene.release-event", e));
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
  { world, characters, characterIds, modelId, key, settingsChangedAt }: PreparedScene,
  attempt: SceneAttempt,
  deps: SceneDeps = {},
): Promise<SceneView> {
  const now = deps.now ?? (() => new Date());
  const { attemptId } = attempt;
  const expected = await prisma.gameState.findUniqueOrThrow({ where: { worldId }, select: { stateVersion: true, maxTurnsPerScene: true } });
  const maxTurns = expected.maxTurnsPerScene;
  const aliases = characters.map((c) => c.alias);
  const promptEvents = await loadPromptEvents(worldId, attempt.autoEvent ?? null, attempt.userEvent ?? null);
  const prompt = buildStoryPrompt(world, characters, maxTurns, await loadRecentHistory(userId, worldId, settingsChangedAt), {
    worldSeconds: world.gameState!.worldSeconds,
    events: promptEvents.events,
  });

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
        responseJsonSchema: sceneResponseJsonSchema(aliases, maxTurns, promptEvents.refs.map((r) => r.alias)),
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
    } else {
      // 수동 시도: 아직 이 시도가 점유 중이고(오래된 점유를 다른 시도가 가져가지 않았고) 준비 이후 설정이 그대로일 때만 커밋한다
      const rt = await tx.simulationRuntime.findUnique({ where: { worldId }, select: { inFlightAttemptId: true } });
      if (rt?.inFlightAttemptId !== attemptId) {
        throw new ConflictError("SCENE_STALE", "생성하는 동안 실행 상태가 바뀌어 이번 장면을 저장하지 않았습니다.");
      }
    }
    if (attempt.expectedSettingsSeq !== undefined && gs.settingsSeq !== attempt.expectedSettingsSeq) throw settingsChangedError();
    const stillActive = await tx.character.count({ where: { id: { in: characterIds }, worldId, deletedAt: null } });
    if (stillActive !== characterIds.length) {
      throw new ConflictError("STALE_REFERENCE", "생성하는 동안 참가 캐릭터가 삭제되어 이번 장면을 저장하지 않았습니다.");
    }
    // 이 장면의 월드 시각: 흐른 시간을 이 트랜잭션에서 정산한다(시계 상태는 유지). 롤백되면 정산도 되돌아가 다음 정산에 포함된다
    const committedAt = now();
    const worldSeconds = await settleWorldClock(tx, worldId, committedAt, "keep");

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
        worldSeconds,
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
    // 감정·관계·기억 제안 반영 (Phase 5-5). 같은 트랜잭션이므로 실패하면 장면과 함께 아무것도 저장되지 않는다
    await applySceneProposals(tx, worldId, scene.id, characters, output.proposals);
    // 사건 발생·진행·해결과 신체 상태(Phase 7-2-2). 같은 트랜잭션이므로 실패·펜싱 거부면 사건·상태도 남지 않는다
    const applied = await applySceneWorld(tx, {
      worldId,
      scene: { id: scene.id, seq: scene.seq },
      worldSeconds,
      now: committedAt,
      participants: characters,
      output,
      refs: promptEvents.refs,
      autoEvent: attempt.autoEvent ?? null,
      userEvent: attempt.userEvent ?? null,
    });
    // 사망으로 대화 가능한 생존자가 2명 미만이면 실행을 멈춘다 (이 시도는 그대로 커밋, 진행 중 표시가 풀리면 PAUSED)
    if ((await countAlive(tx, worldId)) < SCENE_PARTICIPANTS_MIN) {
      const stopped = await tx.simulationRuntime.updateMany({ where: { worldId, status: "RUNNING" }, data: { status: "PAUSING", statusReason: "NOT_ENOUGH_CHARACTERS", nextSceneAt: null } });
      if (stopped.count) await settleWorldClock(tx, worldId, committedAt, "stop");
    }
    await tx.gameState.update({
      where: { worldId },
      data: { stateVersion: { increment: 1 }, changeSeq: { increment: 1 }, nextSceneSeq: { increment: 1 }, lastCommittedAt: now() },
    });

    // 복구 지점(RECOVERY)·자동 저장 슬롯은 건드리지 않는다 (Phase 6: 복구 지점은 다음 불러오기 때만 교체, §9.3)

    // 검증·저장된 내용만 이벤트로 보낸다 (프롬프트·키·응답 원문 없음)
    const notes = await loadSceneNotes(tx, worldId, [{ id: scene.id, seq: scene.seq }]);
    const view = toView(await tx.conversationScene.findUniqueOrThrow({ where: { id: scene.id }, select: sceneSelect }), notes.get(scene.id));
    await publishEvents(tx, worldId, [
      { type: "scene.committed", payload: { scene: JSON.parse(JSON.stringify(view)) } },
      ...(applied.userEventStarted ? [{ type: "world_event.updated" as const, payload: { worldId, reason: "started" } }] : []),
    ]);
    return view;
  });

  notifyWorld(worldId);
  return committed;
}
