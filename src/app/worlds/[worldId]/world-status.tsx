"use client";

import { useEffect, useRef, useState } from "react";
import { USER_EVENT_PENDING_MAX, USER_EVENT_TEXT_MAX_LENGTH } from "../../../../config/limits";
import { userEventTextLength } from "@/lib/schemas/world-event";
import { formatWorldTime, liveWorldSeconds } from "@/lib/world-clock";
import { button } from "../ui";
import { send } from "../world-form";

// 대화 화면의 세계 정보 (Phase 7-2-2). 캐릭터 말풍선과 분리된 시스템 영역.
// - 월드 시각: 서버 상태(worldClock: asOf 시각의 월드 초·흐르는 중)에서 지금까지를 계산해 1초마다 표시한다.
//   폴링·SSE·재연결로 새 값이 와도 화면 값은 뒤로 가지 않는다(서버 값이 더 크면 따라간다).
// - 진행 중 사건: 오래된 것부터. 장면이 커밋될 때마다(refreshKey) 다시 읽는다.
// - 사용자 사건(7-2-3): [사건 일으키기] 모달, 대기 목록·취소. 사용자 사건의 발생 배너는 자동 사건과 다른 색(USER_EVENT_STARTED)으로 보인다.

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
type PendingEvent = { id: string; text: string; createdAt: string; claimed: boolean };

const newRequestId = () => crypto.randomUUID();

/**
 * 진행 중 사건 + 사용자 사건(7-2-3): [사건 일으키기] 모달(200자, 남은 글자 수), 대기 사건 목록과 취소.
 * 목록은 서버 기준이다. 등록·취소·장면 시작/커밋/실패·world_event.updated(SSE)·재연결 때(refreshKey) 다시 읽는다.
 * 같은 입력을 다시 보내면(네트워크 오류 후 재시도) 같은 requestId를 써서 중복 등록되지 않는다. 등록에 성공하면 새 requestId를 만든다.
 */
export function WorldEvents({ worldId, refreshKey }: { worldId: string; refreshKey: string }) {
  const [events, setEvents] = useState<ActiveEvent[]>([]);
  const [pending, setPending] = useState<PendingEvent[]>([]);
  const [reload, setReload] = useState(0);
  const [text, setText] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let alive = true;
    send(`/api/worlds/${worldId}/events`, "GET")
      .then(({ ok, json }) => {
        if (!alive || !ok) return;
        setEvents(json.active as ActiveEvent[]);
        setPending(json.pending as PendingEvent[]);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [worldId, refreshKey, reload]);

  const length = userEventTextLength(text);
  const full = pending.length >= USER_EVENT_PENDING_MAX;
  const canSubmit = !busy && length > 0 && length <= USER_EVENT_TEXT_MAX_LENGTH && !full;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok, json } = await send(`/api/worlds/${worldId}/events`, "POST", { text, requestId });
      if (!ok) {
        setMessage({ tone: "error", text: json?.error?.message ?? "사건을 등록하지 못했습니다." });
        if (json?.error?.code === "USER_EVENT_REQUEST_REUSED") setRequestId(newRequestId());
        return;
      }
      setText("");
      setRequestId(newRequestId());
      setMessage({ tone: "ok", text: "사건을 등록했습니다. 다음 장면부터 등록 순서대로 하나씩 일어납니다." });
      setReload((n) => n + 1);
    } catch {
      setMessage({ tone: "error", text: "사건을 등록하지 못했습니다. 네트워크 상태를 확인하고 다시 시도하세요." });
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const { ok, json } = await send(`/api/worlds/${worldId}/events/${id}`, "DELETE");
      if (!ok) setMessage({ tone: "error", text: json?.error?.message ?? "사건을 취소하지 못했습니다." });
    } catch {
      setMessage({ tone: "error", text: "사건을 취소하지 못했습니다. 네트워크 상태를 확인하세요." });
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  }

  const pendingList = pending.length > 0 && (
    <ul className="mt-1 flex flex-col gap-1">
      {pending.map((e, i) => (
        <li key={e.id} className="flex items-start gap-2">
          <span className="text-xs text-foreground/50">{i + 1}.</span>
          <span className="flex-1 break-words whitespace-pre-wrap">{e.text}</span>
          {e.claimed ? (
            <span className="shrink-0 text-xs text-foreground/60">장면에 반영 중</span>
          ) : (
            <button type="button" className="shrink-0 text-xs text-red-600 underline disabled:opacity-50" onClick={() => void cancel(e.id)} disabled={busy}>
              취소
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <div className="flex items-center justify-end gap-2">
        {pending.length > 0 && <span className="text-xs text-foreground/60">대기 중 사건 {pending.length}개</span>}
        <button
          type="button"
          className={button}
          onClick={() => {
            setMessage(null);
            dialog.current?.showModal();
          }}
        >
          사건 일으키기
        </button>
      </div>
      {(events.length > 0 || pending.length > 0) && (
        <div className="flex flex-col gap-2">
          {events.length > 0 && (
            <div className="rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-sm" aria-label="진행 중 사건">
              <p className="text-xs font-semibold text-foreground/70">진행 중 사건 (오래된 것부터)</p>
              <ul className="mt-1 flex flex-col gap-1">
                {events.map((e) => (
                  <li key={e.id}>
                    {e.urgent && <span className="mr-1 text-red-600">긴급</span>}
                    {e.kind === "USER_INTERVENTION" ? (
                      <span className="mr-1 rounded bg-sky-600/15 px-1 text-xs text-sky-700 dark:text-sky-300">사용자 사건</span>
                    ) : null}
                    <span className="font-medium">{e.kind === "USER_INTERVENTION" ? e.description : e.title}</span>
                    <span className="text-xs text-foreground/60">
                      {" "}
                      · {e.startedSceneSeq ? `장면 #${e.startedSceneSeq}` : ""}
                      {e.startedWorldSeconds !== null ? `, ${formatWorldTime(e.startedWorldSeconds)}` : ""}부터
                    </span>
                    {e.kind !== "USER_INTERVENTION" && <span className="block text-xs text-foreground/70">{e.description}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pending.length > 0 && (
            <div className="rounded-md border border-sky-600/30 bg-sky-600/5 px-3 py-2 text-sm" aria-label="대기 중 사건">
              <p className="text-xs font-semibold text-foreground/70">대기 중 사건 (다음 장면부터 등록 순서대로 하나씩 일어남)</p>
              {pendingList}
            </div>
          )}
        </div>
      )}

      <dialog ref={dialog} className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-lg bg-background p-6 text-foreground backdrop:bg-black/50" aria-label="사건 일으키기">
        <h3 className="text-base font-semibold">사건 일으키기</h3>
        <p className="mt-1 text-xs text-foreground/70">
          사건은 캐릭터에게 내리는 명령이 아니라 이 세계에 실제로 일어나는 일입니다. 캐릭터가 어떻게 반응하고 해결할지는 캐릭터가 스스로 정합니다. 다음 장면부터 등록
          순서대로 하나씩 일어나며, 대기 중 사건은 최대 {USER_EVENT_PENDING_MAX}개입니다.
        </p>
        <textarea
          className="mt-3 h-28 w-full resize-none rounded-md border border-foreground/20 bg-transparent p-2 text-sm"
          placeholder="예: 마을 입구에 정체를 알 수 없는 우주선이 내려앉았다."
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
        <p className={`text-right text-xs ${length > USER_EVENT_TEXT_MAX_LENGTH ? "text-red-600" : "text-foreground/60"}`}>
          남은 글자 {USER_EVENT_TEXT_MAX_LENGTH - length}자
        </p>
        {full && <p className="text-xs text-foreground/70">대기 중 사건이 {USER_EVENT_PENDING_MAX}개입니다. 사건이 일어나거나 취소한 뒤 등록할 수 있습니다.</p>}
        {message && (
          <p role={message.tone === "error" ? "alert" : "status"} className={`mt-2 text-sm ${message.tone === "error" ? "text-red-600" : "text-foreground/80"}`}>
            {message.text}
          </p>
        )}
        {pending.length > 0 && (
          <div className="mt-3 text-sm">
            <p className="text-xs font-semibold text-foreground/70">대기 중 사건</p>
            {pendingList}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={button} onClick={() => dialog.current?.close()} disabled={busy}>
            닫기
          </button>
          <button type="button" className={button} onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? "처리 중…" : "등록"}
          </button>
        </div>
      </dialog>
    </>
  );
}

type Note = { kind: "EVENT_STARTED" | "USER_EVENT_STARTED" | "EVENT_RESOLVED" | "CONDITION" | "DEATH"; text: string };

/** 장면의 시스템 정보 (사건 발생·해결, 신체 상태 변화) */
export function SceneNotes({ notes }: { notes: Note[] }) {
  if (!notes.length) return null;
  return (
    <ul className="flex flex-col gap-1">
      {notes.map((n, i) => (
        <li
          key={i}
          className={`rounded border px-2 py-1 text-xs ${
            n.kind === "DEATH"
              ? "border-red-600/40 bg-red-600/5"
              : n.kind === "USER_EVENT_STARTED"
                ? "border-sky-600/40 bg-sky-600/5"
                : n.kind.startsWith("EVENT")
                  ? "border-amber-600/40 bg-amber-600/5"
                  : "border-foreground/15 bg-foreground/5"
          }`}
        >
          <span className="font-semibold">시스템 · </span>
          {n.text}
        </li>
      ))}
    </ul>
  );
}
