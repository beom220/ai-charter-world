import { z } from "zod";
import { snapshotV3Error, snapshotV3Schema, type SnapshotV3 } from "./v3";

// 게임 스냅샷 payload v4 (Phase 7-2-2). v3 + 월드 시간(GameState.worldSeconds, 장면·사건·상태 변화의 월드 시각)과
// 신체 상태 재구성(온도 불편 원인·단계, 부상과 독립된 고통, 극심 지속 시작, 월드 시간 기준 부상 회복).
// v1·v2·v3 원본(그리고 checksum)은 그대로 두고 읽을 때 v4로 바꾼다. 실행 중 시계 기준(clockAnchorAt)은 담지 않는다(불러오면 IDLE).
// v3 → v4 (DB 마이그레이션 20261028150000과 같은 보존적 매핑):
//   COLD → 추위·경미, VERY_COLD → 추위·심함, HOT → 더위·경미, VERY_HOT → 더위·심함
//   고통 = 부상 MILD·MODERATE → 경미, SEVERE → 심함, CRITICAL → 극심 (원인은 부상 원인)
//   월드 시간 0에서 시작, 기존 부상·온도·고통은 월드 시각 0부터 센다, 장면·사건·변화의 월드 시각은 NULL

const int = z.number().int();
const secs = int.min(0).nullable();
const level = z.enum(["NONE", "MILD", "SEVERE", "EXTREME"]);

const v3Scene = snapshotV3Schema.shape.scenes.element;
const v3Event = snapshotV3Schema.shape.worldEvents.element;
const v3Condition = snapshotV3Schema.shape.characterConditions.element;
const v3Change = snapshotV3Schema.shape.conditionChanges.element;

export const snapshotV4Schema = snapshotV3Schema.extend({
  schemaVersion: z.literal(4),
  gameState: snapshotV3Schema.shape.gameState.extend({ worldSeconds: int.min(0) }),
  scenes: z.array(v3Scene.extend({ worldSeconds: secs })),
  worldEvents: z.array(v3Event.extend({ startedWorldSeconds: secs, resolvedWorldSeconds: secs })),
  characterConditions: z.array(
    v3Condition.omit({ thermal: true, injuryUpdatedSceneSeq: true }).extend({
      thermalCause: z.enum(["NONE", "COLD", "HEAT"]),
      thermalLevel: level,
      thermalSinceSeconds: secs,
      painLevel: level,
      painCause: z.string().max(200).nullable(),
      painSinceSeconds: secs,
      injuryUpdatedAtSeconds: secs,
      extremeSinceSeconds: secs,
      deathWorldSeconds: secs,
    }),
  ),
  conditionChanges: z.array(v3Change.extend({ worldSeconds: secs })),
});

export type SnapshotV4 = z.infer<typeof snapshotV4Schema>;

const THERMAL: Record<SnapshotV3["characterConditions"][number]["thermal"], Pick<SnapshotV4["characterConditions"][number], "thermalCause" | "thermalLevel">> = {
  NORMAL: { thermalCause: "NONE", thermalLevel: "NONE" },
  COLD: { thermalCause: "COLD", thermalLevel: "MILD" },
  VERY_COLD: { thermalCause: "COLD", thermalLevel: "SEVERE" },
  HOT: { thermalCause: "HEAT", thermalLevel: "MILD" },
  VERY_HOT: { thermalCause: "HEAT", thermalLevel: "SEVERE" },
};
const PAIN: Record<SnapshotV3["characterConditions"][number]["injury"], SnapshotV4["characterConditions"][number]["painLevel"]> = {
  NONE: "NONE",
  MILD: "MILD",
  MODERATE: "MILD",
  SEVERE: "SEVERE",
  CRITICAL: "EXTREME",
};

export function migrateV3ToV4(p: SnapshotV3): SnapshotV4 {
  return {
    ...p,
    schemaVersion: 4,
    gameState: { ...p.gameState, worldSeconds: 0 },
    scenes: p.scenes.map((s) => ({ ...s, worldSeconds: null })),
    worldEvents: p.worldEvents.map((e) => ({ ...e, startedWorldSeconds: null, resolvedWorldSeconds: null })),
    characterConditions: p.characterConditions.map(({ thermal, injuryUpdatedSceneSeq, ...c }) => {
      void injuryUpdatedSceneSeq; // 장면 기준 회복 기준은 월드 시간 기준으로 바뀐다 (아래 0부터)
      const injured = c.injury !== "NONE";
      return {
        ...c,
        ...THERMAL[thermal],
        thermalSinceSeconds: thermal === "NORMAL" ? null : 0,
        painLevel: PAIN[c.injury],
        painCause: injured ? c.injuryCause : null,
        painSinceSeconds: injured ? 0 : null,
        injuryUpdatedAtSeconds: injured ? 0 : null,
        extremeSinceSeconds: c.injury === "CRITICAL" ? 0 : null,
        deathWorldSeconds: null,
      };
    }),
    conditionChanges: p.conditionChanges.map((c) => ({ ...c, worldSeconds: null })),
  };
}

/** v3 검사 + 온도 원인·단계 짝, 월드 시각이 현재 월드 시간을 넘지 않음 */
export function snapshotV4Error(p: SnapshotV4): string | null {
  const v3 = snapshotV3Error(p);
  if (v3) return v3;
  const now = p.gameState.worldSeconds;
  const notFuture = (v: number | null) => v === null || v <= now;
  for (const c of p.characterConditions) {
    if ((c.thermalCause === "NONE") !== (c.thermalLevel === "NONE")) return "BAD_CONDITION";
    if (![c.thermalSinceSeconds, c.painSinceSeconds, c.injuryUpdatedAtSeconds, c.extremeSinceSeconds, c.deathWorldSeconds].every(notFuture)) return "BAD_WORLD_TIME";
  }
  if (!p.scenes.every((s) => notFuture(s.worldSeconds)) || !p.worldEvents.every((e) => notFuture(e.startedWorldSeconds) && notFuture(e.resolvedWorldSeconds))) {
    return "BAD_WORLD_TIME";
  }
  return null;
}
