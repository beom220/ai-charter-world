"use client";

import { useEffect, useState } from "react";
import { formatWorldTime, liveWorldSeconds } from "@/lib/world-clock";
import { send } from "../world-form";

// 대화 화면의 세계 정보 (Phase 7-2-2). 캐릭터 말풍선과 분리된 시스템 영역.
// - 월드 시각: 서버 상태(worldClock: asOf 시각의 월드 초·흐르는 중)에서 지금까지를 계산해 1초마다 표시한다.
//   폴링·SSE·재연결로 새 값이 와도 화면 값은 뒤로 가지 않는다(서버 값이 더 크면 따라간다).
// - 진행 중 사건: 오래된 것부터. 장면이 커밋될 때마다(refreshKey) 다시 읽는다.

type Clock = { seconds: number; running: boolean; asOf: string };

export function WorldClock({ clock }: { clock: Clock }) {
  const [now, setNow] = useState(() => Date.now());
  // 새 서버 값이 와도 이미 보여 준 값보다 뒤로 가지 않게, 이전 값의 마지막 표시를 하한으로 둔다
  const [floor, setFloor] = useState(clock.seconds);
  const [prev, setPrev] = useState(clock);
  if (prev !== clock) {
    setPrev(clock);
    setFloor(Math.max(floor, liveWorldSeconds(prev, now)));
  }
  useEffect(() => {
    if (!clock.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [clock.running]);
  const value = Math.max(floor, liveWorldSeconds(clock, now));
  return (
    <span className="text-xs text-foreground/70" title="월드 1일 = 실제 40분 (진행 중일 때만 흐름)">
      🕰 {formatWorldTime(value)}
      <span className="text-foreground/50"> · 월드 1일 = 실제 40분{clock.running ? " (진행 중)" : " (멈춤)"}</span>
    </span>
  );
}

type ActiveEvent = { id: string; kind: "RANDOM" | "USER_INTERVENTION"; title: string; description: string; startedSceneSeq: number | null; startedWorldSeconds: number | null; urgent: boolean };

export function ActiveEvents({ worldId, refreshKey }: { worldId: string; refreshKey: string }) {
  const [events, setEvents] = useState<ActiveEvent[]>([]);
  useEffect(() => {
    let alive = true;
    send(`/api/worlds/${worldId}/events`, "GET")
      .then(({ ok, json }) => {
        if (alive && ok) setEvents(json.active as ActiveEvent[]);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [worldId, refreshKey]);
  if (!events.length) return null;
  return (
    <div className="rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-sm" aria-label="진행 중 사건">
      <p className="text-xs font-semibold text-foreground/70">진행 중 사건 (오래된 것부터)</p>
      <ul className="mt-1 flex flex-col gap-1">
        {events.map((e) => (
          <li key={e.id}>
            {e.urgent && <span className="mr-1 text-red-600">긴급</span>}
            <span className="font-medium">{e.title}</span>
            {e.kind === "USER_INTERVENTION" && <span className="text-xs text-foreground/60"> · 사용자가 일으킨 사건</span>}
            <span className="text-xs text-foreground/60">
              {" "}
              · {e.startedSceneSeq ? `장면 #${e.startedSceneSeq}` : ""}
              {e.startedWorldSeconds !== null ? `, ${formatWorldTime(e.startedWorldSeconds)}` : ""}부터
            </span>
            <span className="block text-xs text-foreground/70">{e.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Note = { kind: "EVENT_STARTED" | "EVENT_RESOLVED" | "CONDITION" | "DEATH"; text: string };

/** 장면의 시스템 정보 (사건 발생·해결, 신체 상태 변화) */
export function SceneNotes({ notes }: { notes: Note[] }) {
  if (!notes.length) return null;
  return (
    <ul className="flex flex-col gap-1">
      {notes.map((n, i) => (
        <li
          key={i}
          className={`rounded border px-2 py-1 text-xs ${
            n.kind === "DEATH" ? "border-red-600/40 bg-red-600/5" : n.kind.startsWith("EVENT") ? "border-amber-600/40 bg-amber-600/5" : "border-foreground/15 bg-foreground/5"
          }`}
        >
          <span className="font-semibold">시스템 · </span>
          {n.text}
        </li>
      ))}
    </ul>
  );
}
