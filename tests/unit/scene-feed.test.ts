import { afterEach, describe, expect, it, vi } from "vitest";
import { anchoredScrollTop, isNearBottom, mergeScenes, sceneRevealed, ScenePlayback, type PlaybackState } from "@/lib/scene-feed";

// 대화 피드 연출 로직 (Phase 5-3 UX). 브라우저 재생 연출만 다루며 서버·Gemini와 무관하다.

const scene = (seq: number, turns = 2) => ({
  id: `s${seq}`,
  seq,
  messages: Array.from({ length: turns }, (_, t) => ({ id: `s${seq}m${t}`, turnIndex: t })),
});

describe("mergeScenes", () => {
  it("seq·turnIndex 오름차순으로 합치고, 새 장면은 맨 아래, 같은 id는 한 번만 넣는다", () => {
    const initial = mergeScenes([], [scene(3), scene(2)]).scenes; // API는 최신순으로 준다
    expect(initial.map((s) => s.seq)).toEqual([2, 3]);

    const reversed = { ...scene(4), messages: [...scene(4).messages].reverse() };
    const { scenes, fresh } = mergeScenes(initial, [reversed, scene(3)]);
    expect(scenes.map((s) => s.seq)).toEqual([2, 3, 4]);
    expect(fresh.map((s) => s.id)).toEqual(["s4"]);
    expect(scenes.at(-1)!.messages.map((m) => m.turnIndex)).toEqual([0, 1]);

    const older = mergeScenes(scenes, [scene(1)]).scenes; // 이전 기록은 위에
    expect(older.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(mergeScenes(older, [scene(2)]).scenes).toBe(older);
  });
});

describe("ScenePlayback", () => {
  afterEach(() => vi.useRealTimers());

  const timing = { gapMs: [500, 900], typingMs: [1500, 3000] } as const;
  const make = () => {
    vi.useFakeTimers();
    const states: PlaybackState[] = [];
    const playback = new ScenePlayback((s) => states.push(s), timing, () => 0); // random 0 → 최소 시간
    const last = () => states.at(-1)!;
    return { playback, last };
  };

  it("쉼 → 입력 중 → 공개를 발언 순서대로 반복하고, 여러 장면도 도착 순서대로 이어 재생한다", () => {
    const { playback, last } = make();
    playback.enqueue(["a0", "a1"]);
    playback.enqueue(["b0"]);
    expect(last()).toEqual({ pending: new Set(["a0", "a1", "b0"]), typing: null }); // 아직 아무것도 공개 안 됨

    const order: (string | null)[] = [];
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(i % 2 === 0 ? 500 : 1500);
      order.push(last().typing);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1); // 타이머는 항상 하나
    }
    // 입력 중 a0 → 공개 → 입력 중 a1 → 공개 → 입력 중 b0 → 공개
    expect(order).toEqual(["a0", null, "a1", null, "b0", null]);
    expect(last().pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("장면 끝 말풍선: 다음 장면이 입력 중이어도 이미 공개된 장면은 공개 상태를 유지하고, 입력 중·대기 발언이 있는 장면만 미공개다", () => {
    const { playback, last } = make();
    playback.enqueue(["a0"]);
    vi.advanceTimersByTime(900 + 3000); // a0 공개
    playback.enqueue(["b0", "b1"]);
    vi.advanceTimersByTime(900); // b0 입력 중
    expect(last().typing).toBe("b0");
    expect(sceneRevealed([{ id: "a0" }], last().pending)).toBe(true);
    expect(sceneRevealed([{ id: "b0" }, { id: "b1" }], last().pending)).toBe(false);
    playback.flush();
    expect(sceneRevealed([{ id: "b0" }, { id: "b1" }], last().pending)).toBe(true);
  });

  it("입력 중인 발언만 표시 대상이고, 그 다음 발언은 공개 전까지 pending에 남는다", () => {
    const { playback, last } = make();
    playback.enqueue(["a0", "a1"]);
    vi.advanceTimersByTime(500);
    expect(last().typing).toBe("a0");
    expect(last().pending.has("a1")).toBe(true);
    vi.advanceTimersByTime(1499);
    expect(last().typing).toBe("a0"); // 최소 입력 시간 전에는 공개하지 않는다
    vi.advanceTimersByTime(1);
    expect(last()).toEqual({ pending: new Set(["a1"]), typing: null });
  });

  it("같은 발언을 다시 넣어도 중복 재생하지 않고, flush·dispose는 타이머와 입력 중 상태를 정리한다", () => {
    const { playback, last } = make();
    playback.enqueue(["a0", "a1"]);
    playback.enqueue(["a0", "a1"]); // SSE와 POST 응답이 같은 장면을 줌
    vi.advanceTimersByTime(500);
    playback.flush();
    expect(last()).toEqual({ pending: new Set(), typing: null });
    expect(vi.getTimerCount()).toBe(0);

    playback.enqueue(["a1"]); // 이미 본 발언은 다시 재생하지 않음
    expect(vi.getTimerCount()).toBe(0);
    playback.enqueue(["c0"]);
    playback.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("스크롤 계산", () => {
  it("하단 근처일 때만 자동 스크롤하고, 이전 기록을 위에 붙여도 보던 위치를 유지한다", () => {
    expect(isNearBottom({ scrollTop: 920, scrollHeight: 1000, clientHeight: 60 })).toBe(true);
    expect(isNearBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 60 })).toBe(false); // 위로 올려 읽는 중
    expect(anchoredScrollTop({ scrollTop: 40, scrollHeight: 1000 }, 1600)).toBe(640);
  });
});
