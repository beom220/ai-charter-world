import { MEMORY_CONTENT_MAX_LENGTH } from "../../../../config/limits";
import { findEventPreset, type EventPreset } from "../../../../config/world-events";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { ensureAutoEventPeriod } from "@/server/domain/events/auto-periods";
import type { UserEventClaim } from "@/server/domain/events/user-events";
import { ConflictError } from "@/server/domain/errors";
import { dangerConfirmed } from "@/server/engine/commit/event-rules";
import {
  DEFAULT_CONDITION_STATE,
  INJURY_LABEL,
  lifeAtRisk,
  painLabel,
  planConditionChange,
  thermalLabel,
  type ConditionChangeRecord,
  type ConditionProposal,
  type ConditionState,
  type DiscomfortLevel,
  type InjuryLevel,
  type ThermalCauseValue,
} from "@/server/engine/commit/condition-rules";
import type { PromptEvent } from "@/server/engine/context/story-prompt";
import { pickAutoEventPreset } from "@/server/engine/director/auto-events";
import { EVENT_ALIASES, type EventAlias, type SceneAlias, type SceneOutput } from "@/server/engine/validation/scene-output";

// 장면의 세계 상태 — 사건·신체 상태 (Phase 7-2-2, 7-2-3 사건 1회 반영, architecture.md §13.3). 런타임 독립.
// 사건은 해결할 퀘스트나 추적할 상태가 아니라 장면에 한 번 일어나는 상황이다. 이후의 연속성은 대화 기록·캐릭터 기억·신체 상태가 맡는다.
// - 자동 사건: 시도 기록 트랜잭션(World 잠금·펜싱 안)에서 구간 추첨을 영속화하고(claimAutoEvent), 예약 장면이면 프리셋을 정해 구간 행에 남긴다
//   (재시도해도 같은 프리셋). 사건 행은 장면 커밋 트랜잭션에서만 만든다 → 실패·펜싱된 시도는 사건을 남기지 않고, 다음 시도가 다시 발생시킨다.
// - 사용자 사건: 시도 기록 때 점유한 PENDING 1건을 이번 장면의 새 사건으로 넣고, 커밋 트랜잭션에서 "PENDING이고 이 시도가 점유 중"일 때만
//   발생 완료로 바꾼다(아니면 장면 전체를 SCENE_STALE로 버린다 → 취소된 사건이 대사에 남지 않는다). 원문은 그대로 두고 realization·대체 프리셋은 쓰지 않는다.
// - 발생 완료 = status RESOLVED + startedSceneSeq = resolvedSceneSeq = 발생 장면 (새 상태값 없음, resolutionSummary 없음). 프롬프트에는 이번 장면의
//   새 사건만 넣고, 이미 발생한 사건(과거 ACTIVE 포함)은 다시 넣지 않는다. 해결 판정·지속 장면 수·우선순위는 관리하지 않는다.
// - 기억: 사건을 겪은 참가자에게 그 장면의 EVENT 기억이 하나도 없으면 사실 기억 1개를 서버가 보완한다(비참가자에게는 전파하지 않음, 같은 내용 중복 방지).
// - 강도: 자동 HIGH 사건은 장면 전체 고강도 악화 한도. 사용자 사건은 기본 MEDIUM이며, 이번 장면 결과가 실제 위험(danger)을 보고하고 상태 제안이
//   그 사건을 원인으로 가리킬 때만 그 캐릭터에게 고강도 한도. 위험이 확인되지 않은 사용자 사건을 원인으로 한 부상·사망 제안은 버린다.
// - 신체 상태: 커밋 때 정산한 월드 시간으로 살아 있는 모든 캐릭터에 규칙을 적용한다(참가자만 제안 반영, 비참가자는 자연 변화·극심 지속만).
//   사건이 지나도 상태는 그대로다. 사망으로 생존자가 2명 미만이 되면 RUNNING을 멈춘다(이 시도는 원자적으로 커밋하고 PAUSING → 시도 종료 후 PAUSED).

type Tx = Prisma.TransactionClient;

export type AutoEventClaim = { periodIndex: number; presetId: string };

/** 시도 기록 트랜잭션에서 부른다. 이번 장면이 자동 사건 예약 장면이면 프리셋을 정해 돌려준다 */
export async function claimAutoEvent(tx: Tx, worldId: string, random: () => number): Promise<AutoEventClaim | null> {
  const gs = await tx.gameState.findUnique({ where: { worldId }, select: { nextSceneSeq: true } });
  if (!gs) return null;
  const decision = await ensureAutoEventPeriod(tx, worldId, gs.nextSceneSeq, random);
  if (!decision?.dueNow) return null;
  if (decision.presetId) return { periodIndex: decision.periodIndex, presetId: decision.presetId };
  const recent = await tx.worldEvent.findMany({
    where: { worldId, kind: "RANDOM", presetId: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 8,
    select: { presetId: true },
  });
  const presetId = pickAutoEventPreset(
    recent.map((e) => ({ presetId: e.presetId, category: findEventPreset(e.presetId)?.category ?? null })),
    random,
  );
  await tx.worldEventPeriod.updateMany({ where: { worldId, periodIndex: decision.periodIndex, presetId: null }, data: { presetId } });
  const row = await tx.worldEventPeriod.findUniqueOrThrow({ where: { worldId_periodIndex: { worldId, periodIndex: decision.periodIndex } } });
  return { periodIndex: decision.periodIndex, presetId: row.presetId! };
}

/** 프롬프트에 넣은 이번 장면의 새 사건 별칭 → 사건 (자동 사건은 아직 id 없음) */
export type EventRef = {
  alias: EventAlias;
  id: string | null;
  /** 자동 고강도(HIGH) 사건 — 장면 전체에 고강도 악화 한도. 사용자 사건은 항상 false (위험 확인 시 캐릭터별로만) */
  highIntensity: boolean;
  intensity: "LOW" | "MEDIUM" | "HIGH";
  kind: "RANDOM" | "USER_INTERVENTION";
};

/** 이번 장면에 발생할 새 사건만 (자동 사건·점유한 사용자 사건). 이미 발생한 사건은 넣지 않는다 */
export async function loadPromptEvents(worldId: string, autoEvent: AutoEventClaim | null, userEvent: UserEventClaim | null = null): Promise<{ events: PromptEvent[]; refs: EventRef[] }> {
  // 점유가 그대로인 대기 사건만 넣는다 (커밋 때도 다시 확인한다)
  const pendingUser = userEvent
    ? await prisma.worldEvent.findFirst({
        where: { id: userEvent.eventId, worldId, kind: "USER_INTERVENTION", status: "PENDING", claimedAttemptId: userEvent.attemptId },
        select: { id: true, title: true, description: true },
      })
    : null;
  const preset = autoEvent ? findEventPreset(autoEvent.presetId) : undefined;
  const events: PromptEvent[] = [];
  const refs: EventRef[] = [];
  if (preset) {
    const alias = EVENT_ALIASES[events.length]!;
    const fallback = findEventPreset(preset.fallbackId);
    events.push({
      alias,
      kind: "RANDOM",
      title: preset.title,
      description: preset.description,
      urgent: preset.urgent,
      fallback: fallback ? { title: fallback.title, description: fallback.description } : null,
    });
    refs.push({ alias, id: null, highIntensity: preset.intensity === "HIGH", intensity: preset.intensity, kind: "RANDOM" });
  }
  if (pendingUser) {
    const alias = EVENT_ALIASES[events.length]!;
    events.push({ alias, kind: "USER_INTERVENTION", title: pendingUser.title, description: pendingUser.description, urgent: false });
    refs.push({ alias, id: pendingUser.id, highIntensity: false, intensity: "MEDIUM", kind: "USER_INTERVENTION" });
  }
  return { events, refs };
}

export { DEFAULT_CONDITION_STATE };

type ConditionRow = ConditionState & { characterId: string };


/** 프롬프트용 신체 상태 요약 (정상이면 빈 배열) */
export function conditionPromptLines(c: ConditionState, nowSeconds: number): string[] {
  return [
    c.thermalLevel !== "NONE" ? thermalLabel(c.thermalCause, c.thermalLevel) : null,
    c.painLevel !== "NONE" ? `${painLabel(c.painLevel)}${c.painCause ? `: ${c.painCause}` : ""}` : null,
    c.injury !== "NONE" ? `부상 ${INJURY_LABEL[c.injury]}${c.injuryCause ? `: ${c.injuryCause}` : ""}` : null,
    lifeAtRisk(c, nowSeconds) ? "생명 위험 (극심한 상태가 오래 이어짐, 치료·대피가 시급함)" : null,
  ].filter((x): x is string => x !== null);
}

const toProposal = (c: SceneOutput["conditions"][number]): ConditionProposal => ({
  thermal: c.thermal ? { cause: c.thermal.cause as ThermalCauseValue, level: c.thermal.level as DiscomfortLevel } : null,
  pain: c.pain ? { level: c.pain.level as DiscomfortLevel, cause: c.pain.cause } : null,
  injury: c.injury ? { level: c.injury.level as InjuryLevel, cause: c.injury.cause } : null,
  treatment: c.treatment,
  death: c.death,
});

/**
 * 장면 커밋 트랜잭션 안에서 사건·신체 상태를 반영한다 (장면 행을 만든 뒤, GameState 갱신 전).
 * 실패하면 트랜잭션 전체가 롤백되어 사건·상태도 남지 않는다.
 */
export async function applySceneWorld(
  tx: Tx,
  input: {
    worldId: string;
    scene: { id: string; seq: number };
    worldSeconds: number;
    now: Date;
    participants: { id: string; alias: SceneAlias }[];
    output: Pick<SceneOutput, "events" | "conditions">;
    refs: EventRef[];
    autoEvent: AutoEventClaim | null;
    userEvent?: UserEventClaim | null;
  },
): Promise<{ userEventStarted: boolean }> {
  const { worldId, scene, worldSeconds, now, participants, output, refs, autoEvent } = input;
  const outcomeOf = new Map(output.events.map((e) => [e.ref, e]));

  const occurred = (description: string) => ({
    status: "RESOLVED" as const, // 발생 완료 (해결 판정이 아니다)
    sourceSceneId: scene.id,
    startedSceneSeq: scene.seq,
    lastSceneSeq: scene.seq,
    resolvedSceneSeq: scene.seq,
    startedWorldSeconds: worldSeconds,
    resolvedWorldSeconds: worldSeconds,
    resolvedAt: now,
    description,
  });
  const occurredEvents: { id: string; text: string; importance: number }[] = [];

  // 1) 사용자 사건: 이 시도가 점유한 대기 사건만 발생 완료로. 그사이 취소·점유 해제됐으면 이 장면(그 사건이 들어간 대사)을 저장하지 않는다
  const userRef = refs.find((r) => r.kind === "USER_INTERVENTION");
  if (userRef && input.userEvent) {
    const event = await tx.worldEvent.findFirst({
      where: { id: userRef.id!, worldId, kind: "USER_INTERVENTION", status: "PENDING", claimedAttemptId: input.userEvent.attemptId },
      select: { description: true },
    });
    const started = event
      ? await tx.worldEvent.updateMany({
          where: { id: userRef.id!, worldId, status: "PENDING", claimedAttemptId: input.userEvent.attemptId },
          data: { ...occurred(event.description), claimedAttemptId: null },
        })
      : { count: 0 };
    if (started.count !== 1) throw new ConflictError("SCENE_STALE", "생성하는 동안 사건이 취소되어 이번 장면을 저장하지 않았습니다.");
    occurredEvents.push({ id: userRef.id!, text: event!.description, importance: 3 });
  }

  // 2) 자동 사건: 구간을 발생 처리(한 번만)하고 발생 완료 사건을 만든다. 생물이 불가능해 대체했다고 답하면 대체 프리셋으로 기록한다
  const newRef = refs.find((r) => r.kind === "RANDOM");
  let newEventId: string | null = null;
  if (autoEvent && newRef) {
    const outcome = outcomeOf.get(newRef.alias);
    const base = findEventPreset(autoEvent.presetId)!;
    const preset: EventPreset = (outcome?.usedFallback && findEventPreset(base.fallbackId)) || base;
    const fired = await tx.worldEventPeriod.updateMany({
      where: { worldId, periodIndex: autoEvent.periodIndex, firedAt: null },
      data: { firedAt: now, presetId: preset.id },
    });
    if (fired.count === 1) {
      const description = outcome?.realization ?? preset.description;
      const event = await tx.worldEvent.create({
        data: { worldId, kind: "RANDOM", presetId: preset.id, intensity: preset.intensity, title: preset.title, ...occurred(description) },
      });
      newEventId = event.id;
      occurredEvents.push({ id: event.id, text: `${preset.title}: ${description}`, importance: preset.intensity === "HIGH" ? 4 : 3 });
      await tx.worldEventPeriod.update({ where: { worldId_periodIndex: { worldId, periodIndex: autoEvent.periodIndex } }, data: { eventId: event.id } });
    }
  }
  const motiveRef = userRef?.id ?? newEventId;
  if (motiveRef) await tx.conversationScene.update({ where: { id: scene.id }, data: { motiveType: "WORLD_EVENT", motiveRef } });

  // 3) 기억: 사건을 겪은 참가자(생존)에게 이 장면의 EVENT 기억이 없으면 사실 기억을 보완한다. 비참가자에게는 전파하지 않는다
  if (occurredEvents.length) await supplementEventMemories(tx, worldId, scene.id, participants, occurredEvents);

  // 4) 신체 상태: 살아 있는 모든 캐릭터 (행이 없으면 기본값으로 만든다)
  const highIntensityEvent = refs.some((r) => r.highIntensity);
  // 사용자 사건: 이번 장면 결과가 실제 위험을 보고한 사건 / 보고하지 않은 사건 (별칭)
  const userRefs = refs.filter((r) => r.kind === "USER_INTERVENTION");
  const userDanger = new Set(userRefs.filter((r) => dangerConfirmed(outcomeOf.get(r.alias)?.danger)).map((r) => r.alias as string));
  const userCalm = new Set(userRefs.filter((r) => !userDanger.has(r.alias)).map((r) => r.alias as string));
  const aliasOf = new Map(participants.map((p) => [p.id, p.alias]));
  const proposalOf = new Map(output.conditions.map((c) => [c.character, c]));
  const eventIdOf = (alias: string | null) => {
    const ref = refs.find((r) => r.alias === alias);
    return ref ? (ref.id ?? newEventId) : null;
  };
  const characters = await tx.character.findMany({ where: { worldId, deletedAt: null }, select: { id: true, condition: true } });
  for (const ch of characters) {
    const before: ConditionRow = { ...DEFAULT_CONDITION_STATE, ...(ch.condition ?? {}), characterId: ch.id };
    if (before.vital === "DEAD") continue;
    const alias = aliasOf.get(ch.id);
    const raw = alias ? proposalOf.get(alias) : undefined;
    let proposal = raw ? toProposal(raw) : null;
    // 위험이 확인되지 않은 사용자 사건(방문·소식·발견 등)을 원인으로 한 부상·사망은 받지 않는다
    if (proposal && raw?.eventRef && userCalm.has(raw.eventRef)) proposal = { ...proposal, injury: null, death: null };
    const high = highIntensityEvent || (!!raw?.eventRef && userDanger.has(raw.eventRef));
    const { next, changes } = planConditionChange(before, proposal, { nowSeconds: worldSeconds, sceneSeq: scene.seq, highIntensityEvent: high });
    if (!changes.length && ch.condition && sameExtreme(before, next)) continue;
    const data = { ...stateData(next), ...(next.vital === "DEAD" ? { diedAt: now } : {}) };
    await tx.characterCondition.upsert({ where: { characterId: ch.id }, create: { characterId: ch.id, worldId, ...data }, update: data });
    if (changes.length) {
      const eventId = raw ? eventIdOf(raw.eventRef) : null;
      await tx.characterConditionChange.createMany({ data: changes.map((c) => changeRow(worldId, ch.id, scene.id, eventId, worldSeconds, c)) });
    }
  }
  return { userEventStarted: !!userRef && !!input.userEvent };
}

const sameExtreme = (a: ConditionState, b: ConditionState) => a.extremeSinceSeconds === b.extremeSinceSeconds;

function stateData(c: ConditionState) {
  return {
    thermalCause: c.thermalCause,
    thermalLevel: c.thermalLevel,
    thermalSinceSeconds: c.thermalSinceSeconds,
    painLevel: c.painLevel,
    painCause: c.painCause,
    painSinceSeconds: c.painSinceSeconds,
    injury: c.injury,
    injuryCause: c.injuryCause,
    injurySceneSeq: c.injurySceneSeq,
    injuryUpdatedAtSeconds: c.injuryUpdatedAtSeconds,
    extremeSinceSeconds: c.extremeSinceSeconds,
    vital: c.vital,
    deathCause: c.deathCause,
    deathSceneSeq: c.deathSceneSeq,
    deathWorldSeconds: c.deathWorldSeconds,
  };
}

const changeRow = (worldId: string, characterId: string, sceneId: string, eventId: string | null, worldSeconds: number, c: ConditionChangeRecord) => ({
  worldId,
  characterId,
  sceneId,
  eventId,
  kind: c.kind,
  fromValue: c.from.slice(0, 20),
  toValue: c.to.slice(0, 20),
  reason: c.reason,
  worldSeconds,
});

const cutText = (text: string, max: number) => {
  const cps = [...text];
  return cps.length > max ? `${cps.slice(0, max - 1).join("")}…` : text;
};

/**
 * 사건 사실 기억 보완 (장면 커밋 트랜잭션). 모델이 이 장면에서 그 참가자의 EVENT 기억을 제안했으면 그대로 두고,
 * 없으면 발생한 사건마다 WITNESSED 기억 1개를 만든다(같은 사건 = 같은 shareGroupId). 같은 소유자에게 같은 내용이 이미 있으면 만들지 않는다.
 */
async function supplementEventMemories(
  tx: Tx,
  worldId: string,
  sceneId: string,
  participants: { id: string }[],
  events: { id: string; text: string; importance: number }[],
): Promise<void> {
  const ids = participants.map((p) => p.id);
  const alive = await tx.character.findMany({ where: { id: { in: ids }, worldId, OR: [{ condition: null }, { condition: { vital: "ALIVE" } }] }, select: { id: true } });
  const remembered = await tx.characterMemory.findMany({ where: { worldId, sourceSceneId: sceneId, kind: "EVENT", ownerCharacterId: { in: ids } }, select: { ownerCharacterId: true } });
  const covered = new Set(remembered.map((m) => m.ownerCharacterId));
  const rows = alive
    .filter((c) => !covered.has(c.id))
    .flatMap((c) => events.map((e) => ({ owner: c.id, event: e, content: cutText(`이 사건을 직접 겪었다 — ${e.text}`, MEMORY_CONTENT_MAX_LENGTH) })));
  if (!rows.length) return;
  const existing = await tx.characterMemory.findMany({
    where: { worldId, ownerCharacterId: { in: rows.map((r) => r.owner) }, content: { in: rows.map((r) => r.content) } },
    select: { ownerCharacterId: true, content: true },
  });
  const seen = new Set(existing.map((m) => `${m.ownerCharacterId}\u0000${m.content}`));
  const data = rows
    .filter((r) => !seen.has(`${r.owner}\u0000${r.content}`))
    .map((r) => ({ worldId, ownerCharacterId: r.owner, kind: "EVENT" as const, acquisition: "WITNESSED" as const, content: r.content, importance: r.event.importance, sourceSceneId: sceneId, shareGroupId: r.event.id }));
  if (data.length) await tx.characterMemory.createMany({ data });
}

/** 대화 가능한(살아 있고 삭제되지 않은) 캐릭터 수 */
export const countAlive = (db: Tx | typeof prisma, worldId: string) =>
  db.character.count({ where: { worldId, deletedAt: null, OR: [{ condition: null }, { condition: { vital: "ALIVE" } }] } });

// ── 대화 화면의 시스템 정보 (사건 배너·상태 변화). 캐릭터 말풍선과 섞지 않는다

export type SceneNote = { kind: "EVENT_STARTED" | "USER_EVENT_STARTED" | "EVENT_RESOLVED" | "CONDITION" | "DEATH"; text: string };

const DISCOMFORT_TEXT: Record<string, string> = { NONE: "없음", MILD: "경미", SEVERE: "심함", EXTREME: "극심" };

function changeText(name: string, c: { kind: string; fromValue: string; toValue: string; reason: string | null }): SceneNote {
  if (c.kind === "DEATH") return { kind: "DEATH", text: `${name} 사망${c.reason ? ` — ${c.reason}` : ""}` };
  const why = c.reason ? ` (${c.reason})` : "";
  if (c.toValue.startsWith("PAIN_")) {
    const to = c.toValue.slice(5);
    return { kind: "CONDITION", text: `${name}: ${to === "NONE" ? "고통이 가라앉음" : `고통(${DISCOMFORT_TEXT[to] ?? to})`}${why}` };
  }
  if (c.kind === "THERMAL") {
    const [cause, level] = c.toValue.split("_") as [ThermalCauseValue, DiscomfortLevel];
    return { kind: "CONDITION", text: `${name}: ${thermalLabel(cause, level)}` };
  }
  const label = INJURY_LABEL[c.toValue as InjuryLevel] ?? c.toValue;
  const verb = c.kind === "TREATMENT" ? "치료" : c.kind === "RECOVERY" ? "회복" : "부상";
  return { kind: "CONDITION", text: `${name}: ${verb} → ${c.toValue === "NONE" ? "부상 없음" : label}${why}` };
}

/** 장면별 시스템 정보 (사건 발생·해결, 신체 상태 변화) */
export async function loadSceneNotes(db: Tx | typeof prisma, worldId: string, scenes: { id: string; seq: number }[]): Promise<Map<string, SceneNote[]>> {
  const notes = new Map<string, SceneNote[]>(scenes.map((s) => [s.id, []]));
  if (!scenes.length) return notes;
  const seqs = scenes.map((s) => s.seq);
  const idBySeq = new Map(scenes.map((s) => [s.seq, s.id]));
  const [events, changes] = await Promise.all([
    db.worldEvent.findMany({
      where: { worldId, OR: [{ startedSceneSeq: { in: seqs } }, { resolvedSceneSeq: { in: seqs } }] },
      orderBy: [{ startedSceneSeq: "asc" }, { createdAt: "asc" }],
      select: { kind: true, title: true, description: true, startedSceneSeq: true, resolvedSceneSeq: true, resolutionSummary: true },
    }),
    db.characterConditionChange.findMany({
      where: { worldId, sceneId: { in: scenes.map((s) => s.id) } },
      orderBy: { createdAt: "asc" },
      select: { sceneId: true, kind: true, fromValue: true, toValue: true, reason: true, character: { select: { name: true } } },
    }),
  ]);
  for (const e of events) {
    if (e.startedSceneSeq !== null && idBySeq.has(e.startedSceneSeq)) {
      notes
        .get(idBySeq.get(e.startedSceneSeq)!)!
        .push(e.kind === "USER_INTERVENTION" ? { kind: "USER_EVENT_STARTED", text: `사용자가 일으킨 사건: ${e.description}` } : { kind: "EVENT_STARTED", text: `사건 발생: ${e.title} — ${e.description}` });
    }
    // 해결 배너는 과거(7-2-2) 기록만: 발생 장면에 끝난 것은 발생 완료이므로 발생 배너 한 번만 보인다
    if (e.resolvedSceneSeq !== null && e.resolvedSceneSeq !== e.startedSceneSeq && idBySeq.has(e.resolvedSceneSeq)) {
      notes.get(idBySeq.get(e.resolvedSceneSeq)!)!.push({ kind: "EVENT_RESOLVED", text: `사건 해결: ${e.title}${e.resolutionSummary ? ` — ${e.resolutionSummary}` : ""}` });
    }
  }
  for (const c of changes) if (c.sceneId) notes.get(c.sceneId)?.push(changeText(c.character.name, c));
  return notes;
}
