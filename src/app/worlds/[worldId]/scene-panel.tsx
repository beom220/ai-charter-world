"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SCENE_INTERVAL_MS, SCENE_PARTICIPANTS_MIN, SCENE_PLAYBACK_TIMING } from "../../../../config/limits";
import { speakerHref } from "@/lib/character-form";
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
import { eventButton, STATUS_LABEL } from "../ui";
import { send } from "../world-form";
import { emitWorldEvent, RUNTIME_EVENT, SAVES_EVENT } from "./world-events";
import { worldCalendar } from "@/lib/world-clock";
import { SceneNotes, WorldClock, WorldEvents, type WorldEventsHandle } from "./world-status";
import { emotionCueText, type SceneNote } from "@/lib/scene-notes";

// 대화 장면 (Phase 5-1~5-4). [▶ 시작]을 누르면 서버 Runner가 활성 캐릭터 중 2~3명을 골라 장면을 계속 만든다.
// - 실행 상태의 기준은 서버 SimulationRuntime이다. 버튼은 start/pause/resume/stop API만 부르고, 화면 상태는 응답과
//   SSE runtime.status로만 바꾼다(lib/simulation-view.ts). 연결이 끊겼다 돌아와도 start·resume을 자동으로 부르지 않는다.
// - scene.started로 "생성 중 · 경과 시간"을 켜고 scene.committed·scene.failed로 끈다. 실패는 피드 밖 시스템 안내로만 보인다.
// - 수동 장면 생성 API(POST /scenes)는 남아 있지만 화면에서는 쓰지 않는다.
// - 세이브(Phase 6): saves.updated·runtime.status는 저장 패널에 브라우저 이벤트로 넘긴다(피드는 그대로).
//   state.replaced(불러오기)면 서버 컴포넌트를 다시 읽는다. 페이지가 이 패널의 key를 불러오기 표식으로 주므로 패널이 새로 마운트되어
//   재생 큐·입력 중 표시·이전 기록 커서·중복 제거 상태·SSE 커서가 모두 초기화되고, 불러오기 전 장면은 남지 않는다.
// - 하나의 연속 대화 피드: 오래된 장면이 위, 최신이 아래(seq·turnIndex 오름차순). 장면 제목은 얇은 구분선으로만 표시한다.
// - 모든 발언은 왼쪽 정렬. 사용자 입력창·감정/관계/기억 변화 알림은 두지 않는다. 연결 상태·시스템 오류는 피드 밖에 둔다.
// - SSE(scene.committed) 또는 POST 응답으로 새 장면이 오면 장면 id로 한 번만 넣고, ScenePlayback 큐로
//   "쉼 → 발언자 입력 중… → 대사 공개"를 순서대로 재생한다. 처음 불러온 기록·이전 기록·sync.required 재조회는 즉시 표시한다.
//   입력 중 표시는 저장된 장면의 재생 연출이며 실제 LLM 생성 상태가 아니다.
// - 하단 고정 바(뮤직 앱 재생 바처럼, 화면 전체 너비): 왼쪽 [사건 일으키기], 가운데 실행 아이콘(시작·일시정지·재개·종료)과
//   속도 아이콘(모달에서 선택), 오른쪽 [저장]·[불러오기], 생성 중 표시. 시작 안내·시스템 안내·오류는 바 바로 위에 함께 고정한다.
// - 스크롤: 피드 자체 스크롤 없이 페이지 스크롤을 쓴다. 처음엔 맨 아래. 하단 근처일 때만 새 발언을 따라 내려가고, 위로 올려 읽는 중이면 움직이지 않는다.
//   '이전 기록 보기'는 피드 맨 위에 있고, 붙인 뒤에도 보던 위치를 유지한다.
// - 세계 정보(Phase 7-2-2, world-status.tsx): 월드 시각, 장면별 사건 발생(그 장면에 한 번)·신체 상태 변화는 캐릭터 말풍선과 구분된
//   중앙 말풍선으로 보여 준다(7-4: 분류별 테두리, 라벨 없음). 사건 발생은 장면 대사 앞, 상태 변화(과거 기록의 사건 해결 포함)는 장면 대사가 모두 공개된 뒤에 보인다.
// - 사용자 사건(Phase 7-2-3): [사건 일으키기]·대기 목록·취소(world-status.tsx). 사건 목록은 장면 시작·커밋·실패와 world_event.updated(등록·취소·발생)
//   SSE, 재연결 때 서버에서 다시 읽는다. 자동·사용자 사건은 같은 디자인이다.
// - 월드 날짜: 각 발언의 부연설명(actionIntent) 아래에 그 장면의 월드 시각("yyyy-mm-dd hh:mm", 시작일 = 세계관 생성일 KST가 Day 0)을 붙이고, 피드에서 월드 날짜가
//   바뀌는 장면(피드 첫 장면 포함) 앞에 "Day N" 구분선을 넣는다. 월드 시각이 없는 7-2-2 이전 장면은 표시하지 않는다.

/** 피드가 쓰는 스크롤 영역 = 페이지 */
const pageScroller = () => document.scrollingElement ?? document.documentElement;

type Message = {
  id: string;
  turnIndex: number;
  speakerCharacterId: string | null;
  speakerName: string;
  dialogue: string;
  actionIntent: string | null;
  emotionCue: string | null;
};
/** 장면 대사 앞에 보이는 사건 발생 배너 */
const isStartNote = (n: SceneNote) => n.kind === "EVENT_STARTED" || n.kind === "USER_EVENT_STARTED";
export type SceneItem = {
  id: string;
  seq: number;
  title: string;
  summary: string;
  contextTruncated: boolean;
  worldSeconds?: number | null;
  notes?: SceneNote[];
  messages: Message[];
};

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
  worldStartDate,
  activeCharacters,
  initialScenes,
  initialHasMore,
  eventCursor,
  initialState,
  saveControls,
}: {
  worldId: string;
  /** 월드 시작일 "yyyy-mm-dd" (Day 0, 세계관 생성일 KST) */
  worldStartDate: string;
  /** 이 세계관의 활성(삭제되지 않은) 캐릭터: 발화자 이름을 상세 페이지로 잇는다(이름이 같아도 ID로 구분, 사망자 포함). 생존자 수는 시작 안내에 쓴다 */
  activeCharacters: { id: string; alive: boolean }[];
  /** 실행 제어 줄에 놓을 [저장]·[불러오기] */
  saveControls: React.ReactNode;
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
  const router = useRouter();
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventsTick, setEventsTick] = useState(0); // 사건 목록 다시 읽기 (SSE)
  // 활성 캐릭터: 서버가 다시 그리면 props로, 숨김에서 복원(<Activity>)되면 SSE 연결 직후 다시 받아 갱신한다
  const [characters, setCharacters] = useState(activeCharacters);
  const [propCharacters, setPropCharacters] = useState(activeCharacters);
  if (propCharacters !== activeCharacters) {
    setPropCharacters(activeCharacters);
    setCharacters(activeCharacters);
  }
  const activeIds = new Set(characters.map((c) => c.id));
  const aliveCount = characters.filter((c) => c.alive).length;

  const scenesRef = useRef(scenes);
  const playbackRef = useRef<ScenePlayback | null>(null);
  const stickRef = useRef(true); // 하단 근처인가 (사용자 스크롤로 갱신)
  const speedDialog = useRef<HTMLDialogElement>(null);
  const eventsRef = useRef<WorldEventsHandle>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(112);
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

  /** 활성 캐릭터 목록을 다시 읽는다 (다른 탭에서 추가·삭제했을 수 있다) */
  const refreshCharacters = useCallback(async () => {
    const { ok, json } = await send(`/api/worlds/${worldId}/characters`, "GET").catch(() => ({ ok: false, json: null }));
    if (ok) setCharacters((json.characters as { id: string; condition: { vital: string } }[]).map((c) => ({ id: c.id, alive: c.condition.vital === "ALIVE" })));
  }, [worldId]);

  // 세계관 이벤트 구독. 이 연결은 장면 생성·실행 명령을 시작하지 않는다 (연결 자체가 서버의 연결 보류를 해제할 뿐)
  useEffect(() => {
    const es = new EventSource(`/api/worlds/${worldId}/simulation/stream?lastEventId=${encodeURIComponent(eventCursor)}`);
    // 이 화면의 연결 ID (서버가 연결 직후 알려 준다). 화면을 떠날 때 이 연결만 정리하도록 보낸다
    let connectionId: string | null = null;
    es.addEventListener("stream.ready", (e) => {
      try {
        connectionId = (JSON.parse((e as MessageEvent<string>).data) as { connectionId?: string }).connectionId ?? null;
      } catch {
        connectionId = null;
      }
    });
    es.onopen = () => {
      setStream("open");
      void refreshState();
      void refreshCharacters();
    };
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
        if (type !== "runtime.status") setEventsTick((n) => n + 1); // 시작(점유)·커밋(발생)·실패(점유 해제)
        if (type === "runtime.status") {
          const parsed = simulationStateSchema.safeParse(payload);
          if (parsed.success) emitWorldEvent(RUNTIME_EVENT, { status: parsed.data.status, inFlight: parsed.data.inFlight });
        }
        if (type === "scene.committed") {
          const scene = (payload as { scene?: SceneItem }).scene;
          if (scene) addScenes([scene], true);
          if (scene?.notes?.some((n) => n.kind === "DEATH")) void refreshCharacters(); // 생존자 수 안내 갱신
        }
      });
    }
    es.addEventListener("saves.updated", () => emitWorldEvent(SAVES_EVENT));
    es.addEventListener("world_event.updated", () => setEventsTick((n) => n + 1)); // 사용자 사건 등록·취소·발생
    // 불러오기: 화면 전체(세계관·캐릭터·기록·상태)를 서버에서 다시 그린다. 이 패널은 새 key로 다시 마운트된다
    es.addEventListener("state.replaced", () => {
      playbackRef.current?.flush();
      router.refresh();
    });
    // 재전송할 수 없으면 상태와 기록을 다시 받는다 (기록은 연출 없이)
    es.addEventListener("sync.required", async () => {
      void refreshState();
      const { ok, json } = await send(`/api/worlds/${worldId}/scenes`, "GET").catch(() => ({ ok: false, json: null }));
      if (ok) addScenes(json.scenes as SceneItem[], false);
    });
    // 대화 화면 이탈(다른 탭·페이지로 이동, 언마운트, <Activity>로 숨김): 연결을 닫고 서버에 알린다.
    // 서버는 DB 기준으로 이 세계관에 남은 대화 화면 연결이 없을 때만 일시정지한다(다른 탭이 보고 있으면 그대로).
    // 새로고침·탭 닫기는 여기 오지 않을 수 있으므로 SSE 연결 종료 → 연결 보류(신규 호출 즉시 중단, 60초 뒤 PAUSED)가 맡는다.
    // 연결 ID를 받기 전(개발 모드 StrictMode의 즉시 cleanup 등)에는 보내지 않는다: 서버에 등록된 적 없는 연결로 일시정지하지 않게.
    return () => {
      playbackRef.current?.flush(); // 화면 이탈 시 진행 중이던 대사 재생을 마무리한다
      es.close();
      if (!connectionId) return;
      void fetch(`/api/worlds/${worldId}/simulation/leave`, {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId }),
      }).catch(() => undefined);
    };
  }, [worldId, eventCursor, addScenes, refreshState, refreshCharacters, router]);

  // 하단 고정 영역 높이(안내 문구 유무·줄바꿈에 따라 바뀜)만큼 피드 아래를 비워 마지막 발언이 가리지 않게 한다
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setDockHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 피드는 자체 스크롤 없이 페이지 스크롤을 쓴다(실행 컨트롤이 하단 고정 바이므로). 사용자 스크롤로 하단 근처 여부를 갱신한다
  useEffect(() => {
    const onScroll = () => (stickRef.current = isNearBottom(pageScroller()));
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // 피드 내용이 바뀐 직후(그리기 전) 스크롤 위치를 맞춘다: 이전 기록 추가 → 위치 유지, 하단 근처 → 맨 아래
  useLayoutEffect(() => {
    const el = pageScroller();
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
      const el = pageScroller();
      anchorRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
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
  const lacksCharacters = aliveCount < SCENE_PARTICIPANTS_MIN && view.state.status === "IDLE";
  const hasDockText = lacksCharacters || view.state.status === "IDLE" || !!notice || (!!view.failure && view.state.status === "RUNNING") || !!error;

  return (
    <section className="flex flex-col gap-3 pt-2" style={{ paddingBottom: dockHeight + 16 }}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          대화 장면 <span className="text-sm font-normal text-foreground/60">· {STATUS_LABEL[view.state.status]}</span>
        </h2>
        <span className="text-xs text-foreground/60" aria-live="polite">
          {STREAM_LABEL[stream]}
        </span>
      </div>
      <WorldClock clock={view.state.worldClock} startDate={worldStartDate} />
      <WorldEvents ref={eventsRef} worldId={worldId} refreshKey={`${scenes.at(-1)?.id ?? ""}:${stream}:${eventsTick}`} />

      <div className="flex min-h-40 flex-col gap-3 rounded-md bg-foreground/[0.02] p-3">
        {hasMore && (
          <div className="flex justify-center">
            <button type="button" className="text-xs text-foreground/70 underline disabled:opacity-50" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "불러오는 중…" : "이전 기록 보기"}
            </button>
          </div>
        )}
        {scenes.length === 0 && <p className="m-auto text-sm text-foreground/50">아직 대화가 없습니다.</p>}
        {scenes.map((s, i) => {
          const visible = s.messages.filter((m) => !play.pending.has(m.id) || play.typing === m.id);
          if (!visible.length) return null; // 재생 차례가 오기 전 장면은 제목도 숨긴다
          const at = s.worldSeconds != null ? worldCalendar(worldStartDate, s.worldSeconds) : null;
          const prev = scenes[i - 1]?.worldSeconds;
          const newDay = at !== null && (prev == null || worldCalendar(worldStartDate, prev).day !== at.day);
          return (
            <div key={s.id} className="flex flex-col gap-2">
              {newDay && (
                <div className="flex justify-center pt-1">
                  <span className="rounded-full bg-foreground/10 px-3 py-0.5 text-[11px] font-semibold text-foreground/70">Day {at.day}</span>
                </div>
              )}
              <div className="flex items-center gap-2 py-1 text-[11px] text-foreground/50">
                <span className="h-px flex-1 bg-foreground/10" />
                <span className="max-w-[70%] truncate">
                  #{s.seq} {s.title} · 허구의 캐릭터 발화 · AI 생성
                </span>
                <span className="h-px flex-1 bg-foreground/10" />
              </div>
              <SceneNotes notes={(s.notes ?? []).filter(isStartNote)} />
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
                      <SpeakerName worldId={worldId} message={m} activeIds={activeIds} />
                      {emotionCueText(m.emotionCue) && <span className="font-normal text-foreground/60"> · {emotionCueText(m.emotionCue)}</span>}
                    </span>
                    <p className={`${bubble} break-words whitespace-pre-wrap`}>{m.dialogue}</p>
                    {m.actionIntent && <span className="text-xs text-foreground/60 italic">({m.actionIntent})</span>}
                    {at && <span className="text-[11px] text-foreground/40">{at.dateTime}</span>}
                  </div>
                ),
              )}
              {visible.length === s.messages.length && !play.typing && <SceneNotes notes={(s.notes ?? []).filter((n) => !isStartNote(n))} />}
              {s.contextTruncated && visible.length === s.messages.length && !play.typing && (
                <p className="text-[11px] text-foreground/50">세계관 컨텍스트 일부가 이번 장면에 반영되지 않았을 수 있습니다.</p>
              )}
            </div>
          );
        })}
      </div>

      {/* 하단 고정 영역: 안내·시스템 문구(있을 때) + 실행 바. 높이를 재서 피드 아래 여백으로 쓴다 */}
      <div ref={dockRef} className="fixed inset-x-0 bottom-0 z-30">
        {hasDockText && (
          <div className="flex flex-col gap-1 bg-background/95 px-4 pt-2 pb-2 backdrop-blur sm:px-6">
            {lacksCharacters ? (
              <p className="text-sm text-foreground/70">
                대화하려면 대화할 수 있는 캐릭터가 {SCENE_PARTICIPANTS_MIN}명 이상 필요합니다.{" "}
                <Link href={`/worlds/${worldId}/characters`} className="underline">
                  캐릭터 탭
                </Link>
                에서 추가하세요.
              </p>
            ) : (
              view.state.status === "IDLE" && (
                <p className="text-xs text-foreground/60">
                  시작하면 참여 캐릭터를 자동으로 정해 장면을 계속 만듭니다. 장면마다 Gemini API를 1회 호출합니다(본인 키 사용, 비용은 Google에서 청구).
                </p>
              )
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
          </div>
        )}
        {/* 하단 고정 바(뮤직 앱 재생 바처럼, 화면 전체 너비): 왼쪽 [사건 일으키기], 가운데 실행·속도 아이콘, 오른쪽 [저장]·[불러오기] */}
        <div
          role="region"
          aria-label="실행 컨트롤"
          className="border-t border-foreground/10 bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
        >
          {/* 모바일: 위 줄 가운데 실행 아이콘, 아래 줄 좌우 버튼. sm 이상: 왼쪽 | 가운데 | 오른쪽 한 줄 */}
          <div className="grid w-full grid-cols-2 items-center gap-2 px-4 py-3 sm:grid-cols-[1fr_auto_1fr] sm:px-6">
            <span className="justify-self-start">
              <button type="button" className={eventButton} onClick={() => eventsRef.current?.open()} aria-haspopup="dialog">
                사건 일으키기
              </button>
            </span>
            <span className="order-first col-span-2 flex items-center justify-center gap-2 sm:order-none sm:col-span-1">
              {!lacksCharacters && (
                <>
                  {controlsFor(view.state.status).map((c) => (
                    <button
                      key={c.label}
                      type="button"
                      aria-label={controlText(c.label)}
                      title={controlText(c.label)}
                      className={c.command === "start" || c.command === "resume" ? playButton : iconButton}
                      disabled={c.command === null || pending}
                      onClick={() => c.command && void runCommand(c.command)}
                    >
                      <ControlIcon command={c.command} />
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-label={`실행 속도: ${INTERVAL_LABEL[view.state.intervalPreset]}`}
                    title={`실행 속도: ${INTERVAL_LABEL[view.state.intervalPreset]}`}
                    className={iconButton}
                    disabled={pending}
                    onClick={() => speedDialog.current?.showModal()}
                    aria-haspopup="dialog"
                  >
                    <SpeedIcon />
                  </button>
                </>
              )}
            </span>
            <span className="flex justify-self-end gap-2">{saveControls}</span>
            {generating && (
              <p role="status" className="col-span-2 truncate text-center text-xs text-foreground/70 sm:col-span-3">
                {generating.participants.length ? `${generating.participants.join(", ")}의 ` : ""}장면을 만들고 있습니다… {Math.max(0, Math.floor((now - generating.startedAt) / 1000))}초 경과
              </p>
            )}
          </div>
        </div>
      </div>
      <dialog
        ref={speedDialog}
        aria-label="실행 속도"
        className="m-auto w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-foreground/20 bg-background p-4 text-foreground backdrop:bg-black/40"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold">실행 속도</h3>
          <button type="button" className="text-xs text-foreground/70 underline" onClick={() => speedDialog.current?.close()}>
            닫기
          </button>
        </div>
        <p className="mt-1 text-xs text-foreground/60">장면이 끝난 뒤 다음 장면을 시작하기까지의 간격입니다.</p>
        <div className="mt-3 flex flex-col gap-2" role="radiogroup" aria-label="실행 속도">
          {INTERVAL_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={view.state.intervalPreset === p}
              disabled={pending}
              onClick={() => {
                speedDialog.current?.close();
                void changeSpeed(p);
              }}
              className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm disabled:opacity-50 ${
                view.state.intervalPreset === p ? "border-foreground/40 bg-foreground/10 font-semibold" : "border-foreground/15 hover:bg-foreground/5"
              }`}
            >
              {INTERVAL_LABEL[p]}
              <span className="text-xs font-normal text-foreground/60">{SCENE_INTERVAL_MS[p] / 1000}초 간격</span>
            </button>
          ))}
        </div>
      </dialog>
    </section>
  );
}

/** 발화자 이름: 이 세계관의 활성 캐릭터면 상세 페이지 링크, 삭제된 캐릭터면 안내만 */
function SpeakerName({ worldId, message, activeIds }: { worldId: string; message: Message; activeIds: ReadonlySet<string> }) {
  const href = speakerHref(worldId, message.speakerCharacterId, activeIds);
  if (href) {
    return (
      <Link href={href} className="hover:underline">
        {message.speakerName}
      </Link>
    );
  }
  return (
    <span title="삭제된 캐릭터라 상세 정보를 볼 수 없습니다.">
      {message.speakerName} <span className="font-normal text-foreground/50">(삭제된 캐릭터)</span>
    </span>
  );
}

// ── 하단 고정 바 아이콘 (패키지 없이 인라인 SVG)
const iconButton =
  "flex h-10 w-10 items-center justify-center rounded-full border border-foreground/20 text-foreground hover:bg-foreground/5 disabled:opacity-50";
const playButton = "flex h-10 w-10 items-center justify-center rounded-full bg-foreground text-background hover:opacity-90 disabled:opacity-50";

/** 버튼 라벨("▶ 재개")에서 기호를 뺀 접근성 이름 */
const controlText = (label: string) => label.replace(/^[^\p{L}]+/u, "");

function ControlIcon({ command }: { command: SimulationCommand | null }) {
  const props = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": true } as const;
  if (command === "start" || command === "resume") return <svg {...props}><path d="M8 5v14l11-7z" /></svg>;
  if (command === "stop") return <svg {...props}><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>;
  return <svg {...props}><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>; // pause, 일시정지 중(비활성)
}

function SpeedIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  );
}
