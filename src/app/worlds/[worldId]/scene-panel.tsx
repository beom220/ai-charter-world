"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SCENE_PARTICIPANTS_MIN, SCENE_PLAYBACK_TIMING } from "../../../../config/limits";
import { anchoredScrollTop, isNearBottom, mergeScenes, ScenePlayback, type PlaybackState } from "@/lib/scene-feed";
import {
  applySimEvent,
  controlsFor,
  initialView,
  INTERVAL_LABEL,
  INTERVAL_PRESETS,
  simulationStateSchema,
  statusNotice,
  withState,
  type IntervalPresetValue,
  type SimEventName,
  type SimulationCommand,
  type SimulationStateView,
  type SimulationView,
} from "@/lib/simulation-view";
import { button, STATUS_LABEL } from "../ui";
import { send } from "../world-form";

// 대화 장면 (Phase 5-1~5-4). [▶ 시작]을 누르면 서버 Runner가 활성 캐릭터 중 2~3명을 골라 장면을 계속 만든다.
// - 실행 상태의 기준은 서버 SimulationRuntime이다. 버튼은 start/pause/resume/stop API만 부르고, 화면 상태는 응답과
//   SSE runtime.status로만 바꾼다(lib/simulation-view.ts). 연결이 끊겼다 돌아와도 start·resume을 자동으로 부르지 않는다.
// - scene.started로 "생성 중 · 경과 시간"을 켜고 scene.committed·scene.failed로 끈다. 실패는 피드 밖 시스템 안내로만 보인다.
// - 수동 장면 생성 API(POST /scenes)는 남아 있지만 화면에서는 쓰지 않는다.
// - 하나의 연속 대화 피드: 오래된 장면이 위, 최신이 아래(seq·turnIndex 오름차순). 장면 제목은 얇은 구분선으로만 표시한다.
// - 모든 발언은 왼쪽 정렬. 사용자 입력창·감정/관계/기억 변화 알림은 두지 않는다. 연결 상태·시스템 오류는 피드 밖에 둔다.
// - SSE(scene.committed) 또는 POST 응답으로 새 장면이 오면 장면 id로 한 번만 넣고, ScenePlayback 큐로
//   "쉼 → 발언자 입력 중… → 대사 공개"를 순서대로 재생한다. 처음 불러온 기록·이전 기록·sync.required 재조회는 즉시 표시한다.
//   입력 중 표시는 저장된 장면의 재생 연출이며 실제 LLM 생성 상태가 아니다.
// - 스크롤: 처음엔 맨 아래. 하단 근처일 때만 새 발언을 따라 내려가고, 위로 올려 읽는 중이면 움직이지 않는다.
//   '이전 기록 보기'는 피드 맨 위에 있고, 붙인 뒤에도 보던 위치를 유지한다.

type Message = { id: string; turnIndex: number; speakerName: string; dialogue: string; actionIntent: string | null; emotionCue: string | null };
export type SceneItem = { id: string; seq: number; title: string; summary: string; contextTruncated: boolean; messages: Message[] };

type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";
const STREAM_LABEL: Record<StreamStatus, string> = {
  connecting: "서버에 연결하고 있습니다.",
  open: "● 실시간 연결됨",
  reconnecting: "연결이 끊겼습니다. 재연결 중입니다.",
  closed: "연결이 끊겼습니다. 새로고침하세요.",
};
const SIM_EVENTS: SimEventName[] = ["runtime.status", "scene.started", "scene.committed", "scene.failed"];

const bubble = "max-w-[90%] rounded-lg bg-foreground/5 px-3 py-2 text-sm";

export function ScenePanel({
  worldId,
  activeCount,
  initialScenes,
  initialHasMore,
  eventCursor,
  initialState,
}: {
  worldId: string;
  activeCount: number;
  initialScenes: SceneItem[];
  initialHasMore: boolean;
  eventCursor: string;
  initialState: SimulationStateView;
}) {
  const [scenes, setScenes] = useState<SceneItem[]>(() => mergeScenes([], initialScenes).scenes);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [play, setPlay] = useState<PlaybackState>({ pending: new Set(), typing: null });
  const [stream, setStream] = useState<StreamStatus>("connecting");
  const [view, setView] = useState<SimulationView>(() => initialView(initialState, Date.now()));
  const [pending, setPending] = useState(false); // 명령·속도 변경 전송 중 (중복 클릭 방지)
  const [now, setNow] = useState(() => Date.now());
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scenesRef = useRef(scenes);
  const playbackRef = useRef<ScenePlayback | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true); // 하단 근처인가 (사용자 스크롤로 갱신)
  const anchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null); // 이전 기록 추가 직전 위치

  useEffect(() => {
    const playback = new ScenePlayback(setPlay, SCENE_PLAYBACK_TIMING);
    playbackRef.current = playback;
    return () => playback.dispose();
  }, []);

  /** 새 장면만 피드에 넣는다. animate면 발언을 재생 큐에 넣는다(큐에 넣은 발언은 공개 전까지 그리지 않음) */
  const addScenes = useCallback((incoming: SceneItem[], animate: boolean) => {
    const { scenes: next, fresh } = mergeScenes(scenesRef.current, incoming);
    if (!fresh.length) return;
    scenesRef.current = next;
    if (animate) for (const s of fresh) playbackRef.current?.enqueue(s.messages.map((m) => m.id));
    setScenes(next);
  }, []);

  /** 서버 상태를 다시 읽는다 (명령 실패·sync.required) */
  const refreshState = useCallback(async () => {
    const { ok, json } = await send(`/api/worlds/${worldId}/simulation/state`, "GET").catch(() => ({ ok: false, json: null }));
    const parsed = ok ? simulationStateSchema.safeParse(json?.state) : null;
    if (parsed?.success) setView((v) => withState(v, parsed.data));
  }, [worldId]);

  // 세계관 이벤트 구독. 이 연결은 장면 생성·실행 명령을 시작하지 않는다 (연결 자체가 서버의 연결 보류를 해제할 뿐)
  useEffect(() => {
    const es = new EventSource(`/api/worlds/${worldId}/simulation/stream?lastEventId=${encodeURIComponent(eventCursor)}`);
    es.onopen = () => setStream("open");
    es.onerror = () => {
      setStream(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
      playbackRef.current?.flush(); // 남은 연출은 건너뛰고 받은 대사를 모두 보여 준다
    };
    for (const type of SIM_EVENTS) {
      es.addEventListener(type, (e) => {
        let payload: unknown;
        try {
          payload = JSON.parse((e as MessageEvent<string>).data);
        } catch {
          return; // 형식이 다른 이벤트는 무시한다
        }
        setView((v) => applySimEvent(v, type, payload, Date.now()));
        if (type === "scene.committed") {
          const scene = (payload as { scene?: SceneItem }).scene;
          if (scene) addScenes([scene], true);
        }
      });
    }
    // 재전송할 수 없으면 상태와 기록을 다시 받는다 (기록은 연출 없이)
    es.addEventListener("sync.required", async () => {
      void refreshState();
      const { ok, json } = await send(`/api/worlds/${worldId}/scenes`, "GET").catch(() => ({ ok: false, json: null }));
      if (ok) addScenes(json.scenes as SceneItem[], false);
    });
    return () => es.close();
  }, [worldId, eventCursor, addScenes, refreshState]);

  // 피드 내용이 바뀐 직후(그리기 전) 스크롤 위치를 맞춘다: 이전 기록 추가 → 위치 유지, 하단 근처 → 맨 아래
  useLayoutEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (anchorRef.current) {
      el.scrollTop = anchoredScrollTop(anchorRef.current, el.scrollHeight);
      anchorRef.current = null;
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [scenes, play]);

  // 생성 경과 시간 표시. 이때는 발언자가 정해지지 않았으므로 캐릭터 입력 중 표시를 하지 않는다
  const generating = view.generating;
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [generating]);

  async function loadMore() {
    const oldest = scenesRef.current[0];
    if (!oldest) return;
    setLoadingMore(true);
    setError(null);
    try {
      const { ok, json } = await send(`/api/worlds/${worldId}/scenes?before=${oldest.seq}`, "GET");
      if (!ok) return setError(json?.error?.message ?? "이전 기록을 불러오지 못했습니다.");
      const el = feedRef.current;
      if (el) anchorRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
      addScenes(json.scenes as SceneItem[], false);
      setHasMore(json.hasMore);
    } catch {
      setError("이전 기록을 불러오지 못했습니다. 네트워크 상태를 확인하세요.");
    } finally {
      setLoadingMore(false);
    }
  }

  /** 실행 명령. 응답의 상태를 그대로 반영하고, 실패하면 서버 상태를 다시 읽어 화면을 맞춘다 */
  async function runCommand(command: SimulationCommand) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const { ok, json } = await send(`/api/worlds/${worldId}/simulation/${command}`, "POST");
      const parsed = ok ? simulationStateSchema.safeParse(json?.state) : null;
      if (parsed?.success) setView((v) => withState(v, parsed.data));
      else {
        setError(json?.error?.message ?? "요청을 처리하지 못했습니다.");
        await refreshState();
      }
    } catch {
      setError("요청을 보내지 못했습니다. 네트워크 상태를 확인하세요.");
      await refreshState();
    } finally {
      setPending(false);
    }
  }

  async function changeSpeed(intervalPreset: IntervalPresetValue) {
    if (pending || intervalPreset === view.state.intervalPreset) return;
    setPending(true);
    setError(null);
    try {
      const { ok, json } = await send(`/api/worlds/${worldId}/simulation/state`, "PATCH", { intervalPreset });
      const parsed = ok ? simulationStateSchema.safeParse(json?.state) : null;
      if (parsed?.success) setView((v) => withState(v, parsed.data));
      else {
        setError(json?.error?.message ?? "실행 속도를 바꾸지 못했습니다.");
        await refreshState();
      }
    } catch {
      setError("실행 속도를 바꾸지 못했습니다. 네트워크 상태를 확인하세요.");
      await refreshState();
    } finally {
      setPending(false);
    }
  }

  const notice = statusNotice(view.state);

  return (
    <section className="flex flex-col gap-3 border-t border-foreground/10 pt-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          대화 장면 <span className="text-sm font-normal text-foreground/60">· {STATUS_LABEL[view.state.status]}</span>
        </h2>
        <span className="text-xs text-foreground/60" aria-live="polite">
          {STREAM_LABEL[stream]}
        </span>
      </div>

      <div
        ref={feedRef}
        onScroll={(e) => (stickRef.current = isNearBottom(e.currentTarget))}
        className="flex max-h-[65vh] min-h-40 flex-col gap-3 overflow-y-auto rounded-md bg-foreground/[0.02] p-3"
      >
        {hasMore && (
          <div className="flex justify-center">
            <button type="button" className="text-xs text-foreground/70 underline disabled:opacity-50" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "불러오는 중…" : "이전 기록 보기"}
            </button>
          </div>
        )}
        {scenes.length === 0 && <p className="m-auto text-sm text-foreground/50">아직 대화가 없습니다.</p>}
        {scenes.map((s) => {
          const visible = s.messages.filter((m) => !play.pending.has(m.id) || play.typing === m.id);
          if (!visible.length) return null; // 재생 차례가 오기 전 장면은 제목도 숨긴다
          return (
            <div key={s.id} className="flex flex-col gap-2">
              <div className="flex items-center gap-2 py-1 text-[11px] text-foreground/50">
                <span className="h-px flex-1 bg-foreground/10" />
                <span className="max-w-[70%] truncate">
                  #{s.seq} {s.title} · 허구의 캐릭터 발화 · AI 생성
                </span>
                <span className="h-px flex-1 bg-foreground/10" />
              </div>
              {visible.map((m) =>
                play.typing === m.id ? (
                  <div key={m.id} className="flex flex-col items-start" aria-label={`${m.speakerName} 입력 중`}>
                    <span className="text-sm font-semibold">
                      {m.speakerName} <span className="font-normal text-foreground/60">· 입력 중…</span>
                    </span>
                    <p className={`${bubble} flex gap-1`} aria-hidden>
                      <span className="typing-dot">●</span>
                      <span className="typing-dot">●</span>
                      <span className="typing-dot">●</span>
                    </p>
                  </div>
                ) : (
                  <div key={m.id} className="flex flex-col items-start">
                    <span className="text-sm font-semibold">
                      {m.speakerName}
                      {m.emotionCue && <span className="font-normal text-foreground/60"> · {m.emotionCue}</span>}
                    </span>
                    <p className={`${bubble} break-words whitespace-pre-wrap`}>{m.dialogue}</p>
                    {m.actionIntent && <span className="text-xs text-foreground/60 italic">({m.actionIntent})</span>}
                  </div>
                ),
              )}
              {s.contextTruncated && visible.length === s.messages.length && !play.typing && (
                <p className="text-[11px] text-foreground/50">세계관 컨텍스트 일부가 이번 장면에 반영되지 않았을 수 있습니다.</p>
              )}
            </div>
          );
        })}
      </div>

      {activeCount < SCENE_PARTICIPANTS_MIN && view.state.status === "IDLE" ? (
        <p className="text-sm text-foreground/70">대화하려면 캐릭터가 {SCENE_PARTICIPANTS_MIN}명 이상 필요합니다.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {controlsFor(view.state.status).map((c) => (
              <button
                key={c.label}
                type="button"
                className={button}
                disabled={c.command === null || pending}
                onClick={() => c.command && void runCommand(c.command)}
              >
                {c.label}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-1 text-xs text-foreground/70" role="group" aria-label="실행 속도">
              속도
              {INTERVAL_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={view.state.intervalPreset === p}
                  disabled={pending}
                  onClick={() => void changeSpeed(p)}
                  className={`rounded px-2 py-1 disabled:opacity-50 ${view.state.intervalPreset === p ? "bg-foreground/10 font-semibold text-foreground" : "hover:bg-foreground/5"}`}
                >
                  {INTERVAL_LABEL[p]}
                </button>
              ))}
            </span>
          </div>
          {view.state.status === "IDLE" && (
            <p className="text-xs text-foreground/60">
              시작하면 참여 캐릭터를 자동으로 정해 장면을 계속 만듭니다. 장면마다 Gemini API를 1회 호출합니다(본인 키 사용, 비용은 Google에서 청구).
            </p>
          )}
          {generating && (
            <p role="status" className="text-sm text-foreground/70">
              {generating.participants.length ? `${generating.participants.join(", ")}의 ` : ""}장면을 만들고 있습니다… {Math.max(0, Math.floor((now - generating.startedAt) / 1000))}초 경과
            </p>
          )}
        </>
      )}
      {notice && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === "warn" ? "border border-amber-600/40 bg-amber-600/5" : "bg-foreground/5"}`}>
          <span className="font-semibold">시스템 · </span>
          {notice.text}
          {notice.settingsLink && (
            <>
              {" "}
              <a href="/settings/providers" className="underline">
                Gemini 설정
              </a>
            </>
          )}
        </p>
      )}
      {view.failure && view.state.status === "RUNNING" && (
        <p role="status" className="rounded-md bg-foreground/5 px-3 py-2 text-sm text-foreground/80">
          <span className="font-semibold">시스템 · </span>
          {view.failure}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-red-600/40 bg-red-600/5 px-3 py-2 text-sm text-red-600">
          <span className="font-semibold">시스템 · </span>
          {error}
        </p>
      )}
    </section>
  );
}
