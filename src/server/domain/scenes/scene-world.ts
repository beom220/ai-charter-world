import { findEventPreset, type EventPreset } from "../../../../config/world-events";
import { formatWorldTime } from "@/lib/world-clock";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/client";
import { ensureAutoEventPeriod } from "@/server/domain/events/auto-periods";
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

// 장면의 세계 상태 — 사건·신체 상태 (Phase 7-2-2, architecture.md §13.3). 런타임 독립.
// - 자동 사건: 시도 기록 트랜잭션(World 잠금·펜싱 안)에서 구간 추첨을 영속화하고(claimAutoEvent), 예약 장면이면 프리셋을 정해 구간 행에 남긴다
//   (재시도해도 같은 프리셋). 사건 행은 장면 커밋 트랜잭션에서만 만든다 → 실패·펜싱된 시도는 사건을 남기지 않고, 다음 시도가 다시 발생시킨다.
// - 진행 중 사건(ACTIVE)은 오래된 순(startedSceneSeq → createdAt → id)으로 E1… 별칭을 붙여 프롬프트에 넣는다.
//   커밋 때 별칭으로만 되돌리므로 다른 사건을 잘못 종료하지 않는다. RESOLVED는 결과 요약이 있을 때만(고강도 새 사건은 첫 장면에 해결 불가).
//   응답에 사건 결과가 없어도 사건은 그대로 진행(ONGOING) 기록된다.
// - 신체 상태: 커밋 때 정산한 월드 시간으로 살아 있는 모든 캐릭터에 규칙을 적용한다(참가자만 제안 반영, 비참가자는 자연 변화·극심 지속만).
//   사망으로 생존자가 2명 미만이 되면 RUNNING을 멈춘다(진행 중인 이 시도는 원자적으로 커밋하고 PAUSING → 시도 종료 후 PAUSED).

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

/** 프롬프트에 넣은 사건 별칭 → 사건 (새 사건은 id 없음) */
export type EventRef = { alias: EventAlias; id: string | null; isNew: boolean; highIntensity: boolean; kind: "RANDOM" | "USER_INTERVENTION" };

const sceneSince = (seq: number | null, seconds: number | null) =>
  seq === null ? null : `장면 #${seq}${seconds === null ? "" : `, ${formatWorldTime(seconds)}`}`;

/** 진행 중 사건(오래된 순) + 이번 장면의 새 자동 사건. 별칭 수를 넘는 최근 사건은 개수만 알린다 */
export async function loadPromptEvents(worldId: string, autoEvent: AutoEventClaim | null): Promise<{ events: PromptEvent[]; refs: EventRef[]; omitted: number }> {
  const active = await prisma.worldEvent.findMany({
    where: { worldId, status: "ACTIVE", kind: { in: ["RANDOM", "USER_INTERVENTION"] } },
    orderBy: [{ startedSceneSeq: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, kind: true, title: true, description: true, presetId: true, intensity: true, startedSceneSeq: true, startedWorldSeconds: true },
  });
  const slots = EVENT_ALIASES.length - (autoEvent ? 1 : 0);
  const shown = active.slice(0, slots);
  const events: PromptEvent[] = [];
  const refs: EventRef[] = [];
  shown.forEach((e, i) => {
    const alias = EVENT_ALIASES[i]!;
    const kind = e.kind as "RANDOM" | "USER_INTERVENTION";
    const preset = findEventPreset(e.presetId);
    events.push({ alias, kind, title: e.title, description: e.description, isNew: false, urgent: preset?.urgent ?? false, since: sceneSince(e.startedSceneSeq, e.startedWorldSeconds) });
    // 사용자 사건은 강도를 정하지 않으므로 고강도 가능성으로 본다(실제 피해 여부는 장면 결과·규칙이 판단)
    refs.push({ alias, id: e.id, isNew: false, highIntensity: kind === "USER_INTERVENTION" || e.intensity === "HIGH", kind });
  });
  const preset = autoEvent ? findEventPreset(autoEvent.presetId) : undefined;
  if (preset) {
    const alias = EVENT_ALIASES[shown.length]!;
    const fallback = findEventPreset(preset.fallbackId);
    events.push({
      alias,
      kind: "RANDOM",
      title: preset.title,
      description: preset.description,
      isNew: true,
      urgent: preset.urgent,
      since: null,
      fallback: fallback ? { title: fallback.title, description: fallback.description } : null,
    });
    refs.push({ alias, id: null, isNew: true, highIntensity: preset.intensity === "HIGH", kind: "RANDOM" });
  }
  return { events, refs, omitted: active.length - shown.length };
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
  },
): Promise<void> {
  const { worldId, scene, worldSeconds, now, participants, output, refs, autoEvent } = input;
  const outcomeOf = new Map(output.events.map((e) => [e.ref, e]));

  // 1) 새 자동 사건: 구간을 발생 처리(한 번만)하고 사건을 만든다. 생물이 불가능해 대체했다고 답하면 대체 프리셋으로 기록한다
  const newRef = refs.find((r) => r.isNew);
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
      const resolved = outcome?.status === "RESOLVED" && !!outcome.resolutionSummary && preset.intensity === "LOW"; // 고강도 새 사건은 첫 장면에 끝내지 않는다
      const event = await tx.worldEvent.create({
        data: {
          worldId,
          kind: "RANDOM",
          status: resolved ? "RESOLVED" : "ACTIVE",
          presetId: preset.id,
          intensity: preset.intensity,
          title: preset.title,
          description: outcome?.realization ?? preset.description,
          sourceSceneId: scene.id,
          startedSceneSeq: scene.seq,
          lastSceneSeq: scene.seq,
          startedWorldSeconds: worldSeconds,
          ...(resolved ? { resolvedSceneSeq: scene.seq, resolvedWorldSeconds: worldSeconds, resolvedAt: now, resolutionSummary: outcome!.resolutionSummary } : {}),
        },
      });
      newEventId = event.id;
      await tx.worldEventPeriod.update({ where: { worldId_periodIndex: { worldId, periodIndex: autoEvent.periodIndex } }, data: { eventId: event.id } });
    }
  }

  // 2) 진행 중 사건: 프롬프트에 넣은 것만 이번 장면에 이어졌다고 기록하고, 결과 요약이 있는 RESOLVED만 해결한다 (별칭으로만 되돌림)
  for (const ref of refs.filter((r) => !r.isNew && r.id)) {
    const outcome = outcomeOf.get(ref.alias);
    const resolved = outcome?.status === "RESOLVED" && !!outcome.resolutionSummary;
    await tx.worldEvent.updateMany({
      where: { id: ref.id!, worldId, status: "ACTIVE" },
      data: resolved
        ? { status: "RESOLVED", lastSceneSeq: scene.seq, resolvedSceneSeq: scene.seq, resolvedWorldSeconds: worldSeconds, resolvedAt: now, resolutionSummary: outcome!.resolutionSummary }
        : { lastSceneSeq: scene.seq },
    });
  }
  const motiveRef = newEventId ?? refs.find((r) => !r.isNew)?.id ?? null;
  if (motiveRef) await tx.conversationScene.update({ where: { id: scene.id }, data: { motiveType: "WORLD_EVENT", motiveRef } });

  // 3) 신체 상태: 살아 있는 모든 캐릭터 (행이 없으면 기본값으로 만든다)
  const highIntensityEvent = refs.some((r) => r.highIntensity);
  const aliasOf = new Map(participants.map((p) => [p.id, p.alias]));
  const proposalOf = new Map(output.conditions.map((c) => [c.character, c]));
  const eventIdOf = (alias: string | null) => {
    const ref = refs.find((r) => r.alias === alias);
    return ref ? (ref.isNew ? newEventId : ref.id) : null;
  };
  const characters = await tx.character.findMany({ where: { worldId, deletedAt: null }, select: { id: true, condition: true } });
  for (const ch of characters) {
    const before: ConditionRow = { ...DEFAULT_CONDITION_STATE, ...(ch.condition ?? {}), characterId: ch.id };
    if (before.vital === "DEAD") continue;
    const alias = aliasOf.get(ch.id);
    const raw = alias ? proposalOf.get(alias) : undefined;
    const { next, changes } = planConditionChange(before, raw ? toProposal(raw) : null, { nowSeconds: worldSeconds, sceneSeq: scene.seq, highIntensityEvent });
    if (!changes.length && ch.condition && sameExtreme(before, next)) continue;
    const data = { ...stateData(next), ...(next.vital === "DEAD" ? { diedAt: now } : {}) };
    await tx.characterCondition.upsert({ where: { characterId: ch.id }, create: { characterId: ch.id, worldId, ...data }, update: data });
    if (changes.length) {
      const eventId = raw ? eventIdOf(raw.eventRef) : null;
      await tx.characterConditionChange.createMany({ data: changes.map((c) => changeRow(worldId, ch.id, scene.id, eventId, worldSeconds, c)) });
    }
  }
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

/** 대화 가능한(살아 있고 삭제되지 않은) 캐릭터 수 */
export const countAlive = (db: Tx | typeof prisma, worldId: string) =>
  db.character.count({ where: { worldId, deletedAt: null, OR: [{ condition: null }, { condition: { vital: "ALIVE" } }] } });

// ── 대화 화면의 시스템 정보 (사건 배너·상태 변화). 캐릭터 말풍선과 섞지 않는다

export type SceneNote = { kind: "EVENT_STARTED" | "EVENT_RESOLVED" | "CONDITION" | "DEATH"; text: string };

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
    const label = e.kind === "USER_INTERVENTION" ? "사용자가 일으킨 사건" : "사건 발생";
    if (e.startedSceneSeq !== null && idBySeq.has(e.startedSceneSeq)) notes.get(idBySeq.get(e.startedSceneSeq)!)!.push({ kind: "EVENT_STARTED", text: `${label}: ${e.title} — ${e.description}` });
    if (e.resolvedSceneSeq !== null && idBySeq.has(e.resolvedSceneSeq)) {
      notes.get(idBySeq.get(e.resolvedSceneSeq)!)!.push({ kind: "EVENT_RESOLVED", text: `사건 해결: ${e.title}${e.resolutionSummary ? ` — ${e.resolutionSummary}` : ""}` });
    }
  }
  for (const c of changes) if (c.sceneId) notes.get(c.sceneId)?.push(changeText(c.character.name, c));
  return notes;
}

/** 진행 중 사건 목록 (대화 화면 시스템 영역, 오래된 순) */
export async function listActiveEvents(worldId: string) {
  const rows = await prisma.worldEvent.findMany({
    where: { worldId, status: "ACTIVE", kind: { in: ["RANDOM", "USER_INTERVENTION"] } },
    orderBy: [{ startedSceneSeq: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, kind: true, title: true, description: true, presetId: true, startedSceneSeq: true, startedWorldSeconds: true },
  });
  return rows.map(({ presetId, ...e }) => ({ ...e, urgent: findEventPreset(presetId)?.urgent ?? false }));
}
