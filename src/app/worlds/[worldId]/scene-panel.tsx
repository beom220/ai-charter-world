"use client";

import { useCallback, useEffect, useState } from "react";
import { SCENE_MESSAGE_REVEAL_INTERVAL_MS, SCENE_PARTICIPANTS_MIN } from "../../../../config/limits";
import { button } from "../ui";
import { send } from "../world-form";

// 대화 장면 생성 (Phase 5-1). 버튼을 누르면 서버가 활성 캐릭터 중 2~3명을 골라 Gemini가 장면 1개를 만든다.
// 모든 발언은 왼쪽 정렬로 표시하고, 사용자 입력창·감정/관계/기억 변화 알림은 두지 않는다.
// 기록은 최신순. '이전 기록 보기'는 지금 가진 가장 오래된 seq를 커서로 더 오래된 장면을 받아 id로 중복을 걸러 붙인다. 자동 스크롤은 하지 않는다.
// Phase 5-3: 세계관 SSE를 열어 두고, 저장이 끝난 장면(scene.committed)을 받으면 발언을 1초 간격으로 하나씩 보여 준다(브라우저 연출).
// - POST 응답과 SSE가 같은 장면을 줄 수 있으므로 장면 id로 한 번만 넣는다. 재연결 시 서버가 Last-Event-ID 이후만 재전송한다.
// - sync.required를 받으면 첫 페이지를 다시 받아 빠진 장면만 합친다. 새로고침하면 DB 기록이 그대로 보인다(연출 없이).

type Message = { id: string; turnIndex: number; speakerName: string; dialogue: string; actionIntent: string | null; emotionCue: string | null };
export type SceneItem = { id: string; seq: number; title: string; summary: string; contextTruncated: boolean; messages: Message[] };

type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";
const STREAM_LABEL: Record<StreamStatus, string> = {
  connecting: "실시간 연결 중…",
  open: "● 실시간 연결됨",
  reconnecting: "재연결 중…",
  closed: "연결 끊김 · 새로고침하세요",
};

export function ScenePanel({
  worldId,
  activeCount,
  initialScenes,
  initialHasMore,
  eventCursor,
}: {
  worldId: string;
  activeCount: number;
  initialScenes: SceneItem[];
  initialHasMore: boolean;
  eventCursor: string;
}) {
  const [scenes, setScenes] = useState<SceneItem[]>(initialScenes);
  const [hasMore, setHasMore] = useState(initialHasMore);
  /** 순차 표시 중인 장면 id → 지금까지 보인 발언 수. 없으면 전부 표시 */
  const [revealed, setRevealed] = useState<Record<string, number>>({});
  const [stream, setStream] = useState<StreamStatus>("connecting");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 장면을 seq 순서(최신 먼저) 자리에 넣는다. 이미 있으면 무시 → 중복 표시 없음 */
  const addScenes = useCallback((incoming: SceneItem[], animate: boolean) => {
    setScenes((prev) => {
      const seen = new Set(prev.map((s) => s.id));
      const fresh = incoming.filter((s) => !seen.has(s.id));
      if (!fresh.length) return prev;
      if (animate) setRevealed((r) => ({ ...r, ...Object.fromEntries(fresh.map((s) => [s.id, 0])) }));
      return [...prev, ...fresh].sort((a, b) => b.seq - a.seq);
    });
  }, []);

  // 세계관 이벤트 구독. 이 연결은 장면 생성을 시작하지 않는다
  useEffect(() => {
    const es = new EventSource(`/api/worlds/${worldId}/simulation/stream?lastEventId=${encodeURIComponent(eventCursor)}`);
    es.onopen = () => setStream("open");
    es.onerror = () => setStream(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    es.addEventListener("scene.committed", (e) => {
      try {
        addScenes([(JSON.parse((e as MessageEvent<string>).data) as { scene: SceneItem }).scene], true);
      } catch {
        // 형식이 다른 이벤트는 무시한다
      }
    });
    es.addEventListener("sync.required", async () => {
      const { ok, json } = await send(`/api/worlds/${worldId}/scenes`, "GET").catch(() => ({ ok: false, json: null }));
      if (ok) addScenes(json.scenes as SceneItem[], false);
    });
    return () => es.close();
  }, [worldId, eventCursor, addScenes]);

  // 발언 순차 표시
  const playing = Object.keys(revealed).length > 0;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setRevealed((r) => {
        const next: Record<string, number> = {};
        for (const [id, n] of Object.entries(r)) {
          const total = scenes.find((s) => s.id === id)?.messages.length ?? 0;
          if (n + 1 < total) next[id] = n + 1;
        }
        return next;
      });
    }, SCENE_MESSAGE_REVEAL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, scenes]);

  // 생성 대기 시간 표시 (40초 이상 걸릴 수 있음)
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  async function loadMore() {
    const oldest = scenes.at(-1);
    if (!oldest) return;
    setLoadingMore(true);
    setError(null);
    try {
      const { ok, json } = await send(`/api/worlds/${worldId}/scenes?before=${oldest.seq}`, "GET");
      if (!ok) return setError(json?.error?.message ?? "이전 기록을 불러오지 못했습니다.");
      setScenes((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...(json.scenes as SceneItem[]).filter((s) => !seen.has(s.id))];
      });
      setHasMore(json.hasMore);
    } catch {
      setError("이전 기록을 불러오지 못했습니다. 네트워크 상태를 확인하세요.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function generate() {
    setBusy(true);
    setElapsed(0);
    setError(null);
    try {
      const { ok, json } = await send(`/api/worlds/${worldId}/scenes`, "POST");
      if (!ok) return setError(json?.error?.message ?? "장면을 만들지 못했습니다.");
      // SSE가 끊겨 있어도 응답으로 표시한다. SSE로 먼저 왔으면 무시된다
      addScenes([json.scene as SceneItem], true);
    } catch {
      setError("장면을 만들지 못했습니다. 네트워크 상태를 확인하세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border-t border-foreground/10 pt-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">대화 장면</h2>
        <span className="text-xs text-foreground/60" aria-live="polite">
          {STREAM_LABEL[stream]}
        </span>
      </div>
      {activeCount < SCENE_PARTICIPANTS_MIN ? (
        <p className="text-sm text-foreground/70">대화하려면 캐릭터가 {SCENE_PARTICIPANTS_MIN}명 이상 필요합니다.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={button} onClick={generate} disabled={busy}>
              {busy ? "생성 중…" : "대화 장면 생성"}
            </button>
            <span className="text-xs text-foreground/60">참여 캐릭터는 자동으로 정해집니다. 누를 때마다 Gemini API를 1회 호출합니다(본인 키 사용).</span>
          </div>
          {busy && (
            <p role="status" className="text-sm text-foreground/70">
              Gemini가 장면을 쓰고 있습니다… {elapsed}초 경과 (최대 1분 정도 걸릴 수 있습니다)
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-red-600/40 bg-red-600/5 px-3 py-2 text-sm text-red-600">
          <span className="font-semibold">시스템 · </span>
          {error}
        </p>
      )}

      {scenes.length > 0 && (
        <ol className="flex flex-col gap-4">
          {scenes.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 rounded-md border border-foreground/15 p-4">
              <div>
                <h3 className="font-medium">
                  #{s.seq} {s.title}
                </h3>
                <p className="text-xs text-foreground/60">허구의 캐릭터 발화 · AI 생성</p>
              </div>
              <ul className="flex flex-col gap-2 text-left">
                {s.messages.slice(0, s.id in revealed ? revealed[s.id]! + 1 : undefined).map((m) => (
                  <li key={m.id} className="flex flex-col items-start">
                    <span className="text-sm font-semibold">
                      {m.speakerName}
                      {m.emotionCue && <span className="font-normal"> · {m.emotionCue}</span>}
                    </span>
                    <p className="max-w-[90%] rounded-lg bg-foreground/5 px-3 py-2 text-sm break-words whitespace-pre-wrap">{m.dialogue}</p>
                    {m.actionIntent && <span className="text-xs text-foreground/60 italic">({m.actionIntent})</span>}
                  </li>
                ))}
              </ul>
              {s.contextTruncated && <p className="text-xs text-foreground/60">세계관 컨텍스트 일부가 이번 장면에 반영되지 않았을 수 있습니다.</p>}
            </li>
          ))}
        </ol>
      )}
      {hasMore && (
        <div>
          <button type="button" className={button} onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "불러오는 중…" : "이전 기록 보기"}
          </button>
        </div>
      )}
    </section>
  );
}
