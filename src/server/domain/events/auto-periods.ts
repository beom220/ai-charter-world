import type { Prisma } from "@/generated/prisma/client";
import { autoEventPeriodOf, rollAutoEventPeriod } from "@/server/engine/director/auto-events";

// 자동 사건 20장면 구간 추첨 영속화 (Phase 7-2 명세 §2). 런타임 독립.
// - 구간마다 WorldEventPeriod 1행만 만든다(PK worldId·periodIndex). 이미 있으면 그 결과를 그대로 쓴다 → Runner 재시작·재시도·
//   동시 실행·불러오기(스냅샷에 포함)에서 다시 추첨하지 않는다.
// - 호출자는 World 행 잠금을 잡은 장면 시도 기록 트랜잭션(펜싱 안)에서 부른다. 동시 INSERT도 ON CONFLICT DO NOTHING으로 한 행만 남는다.
// - 발생 처리(프리셋 확정·사건 생성·firedAt)는 장면 커밋 트랜잭션에서 한다(7-2-2).

type Tx = Prisma.TransactionClient;

export type AutoEventDecision = {
  periodIndex: number;
  won: boolean;
  scheduledSceneSeq: number | null;
  presetId: string | null;
  eventId: string | null;
  /** 이번 장면에서 자동 사건을 발생시켜야 하는가 (당첨·예약 장면 도달·아직 미발생) */
  dueNow: boolean;
};

export async function ensureAutoEventPeriod(tx: Tx, worldId: string, sceneSeq: number, random: () => number): Promise<AutoEventDecision | null> {
  const period = autoEventPeriodOf(sceneSeq);
  if (!period) return null;
  // 구간 중간에 처음 판정하면(기존 진행 세계관·불러오기) 지난 장면에는 예약하지 않는다
  const roll = rollAutoEventPeriod(period, random, sceneSeq);
  await tx.worldEventPeriod.createMany({
    data: [{ worldId, periodIndex: period.index, won: roll.won, scheduledSceneSeq: roll.scheduledSceneSeq }],
    skipDuplicates: true,
  });
  const row = await tx.worldEventPeriod.findUniqueOrThrow({ where: { worldId_periodIndex: { worldId, periodIndex: period.index } } });
  return {
    periodIndex: row.periodIndex,
    won: row.won,
    scheduledSceneSeq: row.scheduledSceneSeq,
    presetId: row.presetId,
    eventId: row.eventId,
    dueNow: row.won && row.firedAt === null && row.scheduledSceneSeq !== null && row.scheduledSceneSeq <= sceneSeq,
  };
}
