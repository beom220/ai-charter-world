// 대화 피드 순수 로직 (클라이언트 전용 연출, Phase 5-3 UX). DOM·React에 의존하지 않아 단위 테스트한다.
// - mergeScenes: 장면을 seq 오름차순(오래된 것 위)으로 합치고 id로 중복을 거른다.
// - ScenePlayback: 새로 도착한 장면 발언을 하나의 큐로 순서대로 재생한다(쉼 → 입력 중 → 공개). 타이머는 항상 최대 1개.
//   Gemini 토큰 스트리밍이 아니라 이미 저장된 장면의 재생 연출이다.
// - sceneRevealed: 장면 끝 시스템 말풍선(상태 변화)을 보일 시점.
// - isNearBottom·anchoredScrollTop: 자동 스크롤 여부와 이전 기록 추가 시 위치 유지 계산.

export type FeedScene = { id: string; seq: number; messages: { id: string; turnIndex: number }[] };

/** 기존 + 새 장면을 seq 오름차순으로 합친다. 이미 있는 id는 버린다. fresh = 실제로 추가된 장면(오름차순) */
export function mergeScenes<T extends FeedScene>(prev: T[], incoming: T[]): { scenes: T[]; fresh: T[] } {
  const seen = new Set(prev.map((s) => s.id));
  const fresh: T[] = [];
  for (const s of incoming) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    fresh.push({ ...s, messages: [...s.messages].sort((a, b) => a.turnIndex - b.turnIndex) });
  }
  if (!fresh.length) return { scenes: prev, fresh };
  fresh.sort((a, b) => a.seq - b.seq);
  return { scenes: [...prev, ...fresh].sort((a, b) => a.seq - b.seq), fresh };
}

/** 장면의 대사가 모두 공개되었는가 (입력 중·대기 발언이 없음). 다른 장면이 입력 중이어도 이미 공개된 장면에는 영향이 없다 */
export function sceneRevealed(messages: readonly { id: string }[], pending: ReadonlySet<string>): boolean {
  return messages.every((m) => !pending.has(m.id));
}

export type PlaybackTiming = { gapMs: readonly [number, number]; typingMs: readonly [number, number] };
/** pending = 아직 공개되지 않은 발언 id(화면에 그리지 않음), typing = 지금 입력 중으로 표시할 발언 id */
export type PlaybackState = { pending: ReadonlySet<string>; typing: string | null };

type Timers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };

export class ScenePlayback {
  private queue: string[] = [];
  private pending = new Set<string>();
  private typing: string | null = null;
  private timer: unknown = null;
  private readonly known = new Set<string>();

  constructor(
    private readonly onChange: (state: PlaybackState) => void,
    private readonly timing: PlaybackTiming,
    private readonly random: () => number = Math.random,
    private readonly timers: Timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (h) => globalThis.clearTimeout(h as number) },
  ) {}

  /** 장면 발언을 큐 끝에 넣는다(호출 순서 = 재생 순서). 이미 넣은 발언은 무시 → 중복 재생 없음 */
  enqueue(messageIds: string[]): void {
    const fresh = messageIds.filter((id) => !this.known.has(id));
    if (!fresh.length) return;
    for (const id of fresh) {
      this.known.add(id);
      this.pending.add(id);
    }
    this.queue.push(...fresh);
    this.emit();
    if (this.timer === null) this.schedule(this.timing.gapMs, () => this.startTyping());
  }

  /** 남은 연출을 건너뛰고 모두 공개한다(연결 오류 등). 타이머를 정리한다 */
  flush(): void {
    this.stop();
    this.emit();
  }

  /** 언마운트 시 정리. 이후 알림을 보내지 않는다 */
  dispose(): void {
    this.stop();
  }

  private stop() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.pending.clear();
    this.typing = null;
  }

  private startTyping() {
    const next = this.queue[0];
    if (next === undefined) return;
    this.typing = next;
    this.emit();
    this.schedule(this.timing.typingMs, () => this.reveal());
  }

  private reveal() {
    const id = this.queue.shift();
    if (id !== undefined) this.pending.delete(id);
    this.typing = null;
    this.emit();
    if (this.queue.length) this.schedule(this.timing.gapMs, () => this.startTyping());
  }

  private schedule([min, max]: readonly [number, number], fn: () => void) {
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      fn();
    }, min + Math.round(this.random() * (max - min)));
  }

  private emit() {
    this.onChange({ pending: new Set(this.pending), typing: this.typing });
  }
}

type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** 하단 근처(threshold px 이내)면 새 발언에 맞춰 따라 내려간다. 위로 올려 읽는 중이면 false */
export function isNearBottom(m: ScrollMetrics, threshold = 80): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}

/** 위쪽에 이전 기록을 붙인 뒤에도 보던 위치를 유지하는 scrollTop */
export function anchoredScrollTop(before: Pick<ScrollMetrics, "scrollTop" | "scrollHeight">, afterScrollHeight: number): number {
  return before.scrollTop + (afterScrollHeight - before.scrollHeight);
}
