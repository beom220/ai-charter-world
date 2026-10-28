import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { OUTBOX_CLEANUP_INTERVAL_MS, RUNNER_POLL_INTERVAL_MS, RUNNER_SWEEP_INTERVAL_MS } from "../../../../config/limits";
import { prisma } from "@/server/db/client";
import type { SceneDeps } from "@/server/domain/scenes/generate-scene";
import { cleanupExpiredEvents } from "@/server/events/outbox-cleanup";
import { logServerError } from "@/server/logging/log";
import { registerRunnerHost, type RunnerSignalTarget } from "./signal";
import { runWorldTick, type RunnerContext, type TickResult } from "./world-tick";

// InProcessRunnerHost — Next.js 서버 프로세스 안에서 세계관별 Runner를 돌린다 (architecture.md §7.7 MVP). 런타임 독립.
// - 시작: instrumentation.ts register()(Node runtime, 프로세스당 1회) → startRunnerHost(). 프로세스 전역(globalThis) 단일 인스턴스라
//   개발 서버 HMR로 모듈이 다시 로드되어도 호스트·Runner가 늘어나지 않는다. 여러 프로세스여도 DB lease가 세계관당 1개를 보장한다.
// - 발견: ① 제어 명령 후 signal(worldId) ② 15초 복구 스위퍼(RUNNING·PAUSING이고 lease가 비었거나 만료·내 것) ③ 부팅 직후 스위프.
//   메모리의 Runner 유무는 힌트일 뿐이고, 실행 여부는 매 단계 DB(status·lease)로 판단한다.
// - Runner 루프: runWorldTick → 결과대로 대기(최대 2초, signal이면 즉시 깨어남) → 반복. exit(PAUSED·IDLE·삭제·lease 상실)면 끝난다.
// - 종료: shutdown() → 스위퍼 중지, Runner에 중단 표시·깨우기, 진행 중 단계가 끝날 때까지 기다린 뒤 진행 중 시도가 없는 lease를 해제.
//   프로세스가 비정상 종료되면 lease 만료(30초) 후 다른 호스트·재시작한 호스트의 스위퍼가 이어받는다.
//   타이머는 unref라 프로세스 종료를 막지 않는다. HTTP 요청 수명과 무관하게 돈다(서버리스 배포에는 맞지 않음, §15).
// - 정리: 스위퍼가 OUTBOX_CLEANUP_INTERVAL_MS(10분)마다 24시간 지난 outbox와 남은 SSE 연결 행을 지운다(기다리지 않음, Runner와 무관).

export type RunnerHostOptions = {
  owner?: string;
  deps?: SceneDeps;
  sweepIntervalMs?: number;
};

class WorldRunner {
  private stopped = false;
  private wakeUp: (() => void) | null = null;
  readonly done: Promise<void>;

  constructor(
    readonly worldId: string,
    private readonly ctx: RunnerContext,
  ) {
    this.done = this.loop();
  }

  wake(): void {
    this.wakeUp?.();
  }

  stop(): void {
    this.stopped = true;
    this.wake();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let result: TickResult;
      try {
        result = await runWorldTick(this.worldId, this.ctx);
      } catch (error) {
        logServerError("runner.tick", error); // DB 오류 등: 폴링 간격 뒤 다시 확인
        result = { kind: "wait", ms: RUNNER_POLL_INTERVAL_MS };
      }
      if (result.kind === "exit") return;
      if (result.ms > 0 && !this.stopped) await this.sleep(result.ms);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.wakeUp = done;
    });
  }
}

export class InProcessRunnerHost implements RunnerSignalTarget {
  readonly owner: string;
  private readonly runners = new Map<string, WorldRunner>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private lastCleanupAt = 0;
  private cleaning: Promise<void> | null = null;

  constructor(private readonly options: RunnerHostOptions = {}) {
    this.owner = options.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }

  async start(): Promise<void> {
    if (this.sweeper || this.stopping) return;
    this.sweeper = setInterval(() => void this.sweep(), this.options.sweepIntervalMs ?? RUNNER_SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
    await this.sweep(); // 부팅 시 RUNNING·PAUSING 복구
  }

  /** 제어 명령이 기록되었다는 힌트. 실행 중인 Runner는 깨우고, 없으면 붙인다(실행 대상인지는 Runner가 DB로 판단) */
  signal(worldId: string): void {
    const runner = this.runners.get(worldId);
    if (runner) runner.wake();
    else this.spawn(worldId);
  }

  /** lease가 비었거나 만료되었거나 내 것인 RUNNING·PAUSING 세계관에 Runner를 붙인다 */
  async sweep(): Promise<void> {
    if (this.stopping) return;
    try {
      const rows = await prisma.simulationRuntime.findMany({
        where: {
          status: { in: ["RUNNING", "PAUSING"] },
          OR: [{ leaseOwner: null }, { leaseOwner: this.owner }, { leaseExpiresAt: { lt: new Date() } }],
        },
        select: { worldId: true },
      });
      for (const { worldId } of rows) this.spawn(worldId);
    } catch (error) {
      logServerError("runner.sweep", error);
    }
    this.cleanupIfDue();
  }

  /** 정리는 기다리지 않는다. 한 번에 하나만 돈다 */
  private cleanupIfDue(): void {
    if (this.cleaning || Date.now() - this.lastCleanupAt < OUTBOX_CLEANUP_INTERVAL_MS) return;
    this.lastCleanupAt = Date.now();
    this.cleaning = cleanupExpiredEvents()
      .then(() => undefined)
      .catch((e: unknown) => logServerError("runner.cleanup", e))
      .finally(() => {
        this.cleaning = null;
      });
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    const runners = [...this.runners.values()];
    for (const runner of runners) runner.stop();
    await Promise.all([...runners.map((r) => r.done), this.cleaning]);
    // 진행 중 시도가 없는 lease만 놓는다. 진행 중이면 다른 호스트가 결과 불확실 기간을 지킬 수 있게 그대로 둔다
    await prisma.simulationRuntime
      .updateMany({ where: { leaseOwner: this.owner, inFlightAttemptId: null }, data: { leaseOwner: null, leaseExpiresAt: null } })
      .catch((e: unknown) => logServerError("runner.shutdown", e));
  }

  /** 테스트·진단용: 현재 붙어 있는 Runner의 세계관 */
  activeWorldIds(): string[] {
    return [...this.runners.keys()];
  }

  private spawn(worldId: string): void {
    if (this.stopping || this.runners.has(worldId)) return;
    const runner = new WorldRunner(worldId, { owner: this.owner, deps: this.options.deps, state: { failures: 0 } });
    this.runners.set(worldId, runner);
    void runner.done.finally(() => {
      if (this.runners.get(worldId) === runner) this.runners.delete(worldId);
    });
  }
}

const slot = globalThis as { __inProcessRunnerHost?: InProcessRunnerHost };

/** 프로세스당 1개. 이미 시작되어 있으면 그대로 둔다 (instrumentation 중복 호출·HMR) */
export async function startRunnerHost(options: RunnerHostOptions = {}): Promise<InProcessRunnerHost> {
  const existing = slot.__inProcessRunnerHost;
  if (existing) return existing;
  const host = new InProcessRunnerHost(options);
  slot.__inProcessRunnerHost = host;
  registerRunnerHost(host);
  await host.start();
  return host;
}

export async function stopRunnerHost(): Promise<void> {
  const host = slot.__inProcessRunnerHost;
  if (!host) return;
  slot.__inProcessRunnerHost = undefined;
  registerRunnerHost(undefined);
  await host.shutdown();
}
