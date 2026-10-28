"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { SAVE_NAME_MAX_LENGTH } from "../../../../config/limits";
import { send } from "../world-form";
import { RUNTIME_EVENT, SAVES_EVENT } from "./world-events";

// 저장·불러오기 (Phase 6 기능, UI 개선). 대화 화면의 실행 제어 줄에 [저장]·[불러오기] 버튼을 두고 모달(<dialog>)로 연다.
// - 저장: 이름을 입력해 수동 저장(최대 5개). 가득 차면 기존 수동 저장을 골라 덮어쓴다.
// - 불러오기: 수동·자동 저장을 한 목록(마지막 저장 시각 내림차순)으로 보여 주고, 이름 변경·삭제·덮어쓰기(수동만)와 불러오기를 제공한다.
//   복구 지점(불러오기 직전 상태)은 아래 '복구' 영역에 따로 둔다. 실제 복원 전에 확인을 받는다.
// - 불러오기는 IDLE(진행 중 장면 없음)에서만 된다. 실행·일시정지 중이면 버튼을 막고 종료 후 불러오라고 안내한다(서버도 409).
// - 목록은 서버 기준이다. SSE saves.updated(자동 저장 포함)가 오면 다시 읽는다. 불러오면 화면 전체를 다시 그린다(state.replaced).

export type SaveSlot = { id: string; kind: "MANUAL" | "AUTO" | "RECOVERY"; name: string; autoSlot: number | null; savedAt: string; sceneCount: number; characterCount: number };
export type SaveList = { saves: SaveSlot[]; recovery: SaveSlot | null; manualLimit: number; canLoad: boolean };

const when = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" });
const small = "rounded border border-foreground/20 px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50";
const LOAD_BLOCKED = "시뮬레이션 종료 후 불러올 수 있습니다.";

export function SaveControls({ worldId, initial, buttonClass }: { worldId: string; initial: SaveList; buttonClass: string }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<"save" | "load">("save");
  const [list, setList] = useState(initial);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const { ok, json } = await send(`/api/worlds/${worldId}/saves`, "GET").catch(() => ({ ok: false, json: null }));
    if (ok) setList(json as SaveList);
  }, [worldId]);

  // 대화 패널의 SSE가 보내는 알림: 슬롯 변경 → 목록 다시 읽기, 실행 상태 변경 → 불러오기 가능 여부 갱신
  useEffect(() => {
    const onSaves = () => void refresh();
    const onRuntime = (e: Event) => {
      const { status, inFlight } = (e as CustomEvent<{ status: string; inFlight: boolean }>).detail;
      setList((l) => ({ ...l, canLoad: status === "IDLE" && !inFlight }));
    };
    window.addEventListener(SAVES_EVENT, onSaves);
    window.addEventListener(RUNTIME_EVENT, onRuntime);
    return () => {
      window.removeEventListener(SAVES_EVENT, onSaves);
      window.removeEventListener(RUNTIME_EVENT, onRuntime);
    };
  }, [refresh]);

  function open(next: "save" | "load") {
    setMode(next);
    setNotice(null);
    setRenaming(null);
    void refresh();
    dialog.current?.showModal();
  }

  /** 요청 하나를 보내고 결과를 안내한다. 전송 중에는 다른 버튼을 막는다 */
  async function act(path: string, method: string, body: unknown, success: string): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setNotice(null);
    try {
      const { ok, json } = await send(path, method, body);
      if (!ok) {
        setNotice({ kind: "error", text: json?.error?.message ?? "요청을 처리하지 못했습니다." });
        await refresh();
        return false;
      }
      setNotice({ kind: "ok", text: success });
      await refresh();
      return true;
    } catch {
      setNotice({ kind: "error", text: "요청을 보내지 못했습니다. 네트워크 상태를 확인하세요." });
      return false;
    } finally {
      setPending(false);
    }
  }

  const manual = list.saves.filter((s) => s.kind === "MANUAL");
  const full = manual.length >= list.manualLimit;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (await act(`/api/worlds/${worldId}/saves`, "POST", { name }, "저장했습니다.")) setName("");
  }

  async function load(slot: SaveSlot) {
    const label = slot.kind === "RECOVERY" ? "복구 지점" : `"${slot.name}"`;
    if (!window.confirm(`${label}을(를) 불러올까요?\n현재 진행 상태는 복구 지점으로 보관되고, 대화·감정·관계·기억이 저장 시점으로 바뀝니다.`)) return;
    if (await act(`/api/worlds/${worldId}/saves/${slot.id}/load`, "POST", undefined, "불러왔습니다.")) {
      dialog.current?.close();
      router.refresh();
    }
  }

  async function overwrite(slot: SaveSlot) {
    if (!window.confirm(`"${slot.name}"을(를) 현재 상태로 덮어쓸까요? 이전 저장 내용은 사라집니다.`)) return;
    await act(`/api/worlds/${worldId}/saves/${slot.id}/overwrite`, "POST", undefined, "덮어썼습니다.");
  }

  async function remove(slot: SaveSlot) {
    if (!window.confirm(`"${slot.name}"을(를) 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await act(`/api/worlds/${worldId}/saves/${slot.id}`, "DELETE", undefined, "삭제했습니다.");
  }

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    if (await act(`/api/worlds/${worldId}/saves/${renaming.id}`, "PATCH", { name: renaming.name }, "이름을 바꿨습니다.")) setRenaming(null);
  }

  const row = (s: SaveSlot, actions: "load" | "overwrite") => (
    <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
      <span className={`rounded px-1.5 py-0.5 text-[11px] ${s.kind === "MANUAL" ? "bg-foreground/10" : "bg-foreground/5 text-foreground/70"}`}>{s.kind === "MANUAL" ? "수동" : "자동"}</span>
      {renaming?.id === s.id ? (
        <form onSubmit={rename} className="flex flex-1 gap-1">
          <input
            value={renaming.name}
            onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
            maxLength={SAVE_NAME_MAX_LENGTH}
            aria-label="새 이름"
            className="min-w-0 flex-1 rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
            autoFocus
          />
          <button type="submit" className={small} disabled={pending || renaming.name.trim().length === 0}>
            확인
          </button>
          <button type="button" className={small} onClick={() => setRenaming(null)}>
            취소
          </button>
        </form>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{s.name}</span>
          <span className="text-xs text-foreground/60">
            {when(s.savedAt)} · 장면 {s.sceneCount}개 · 캐릭터 {s.characterCount}명
          </span>
        </span>
      )}
      {renaming?.id !== s.id && (
        <span className="flex flex-wrap gap-1">
          {actions === "load" && (
            <button type="button" className={small} disabled={pending || !list.canLoad} title={list.canLoad ? undefined : LOAD_BLOCKED} onClick={() => void load(s)}>
              불러오기
            </button>
          )}
          {s.kind === "MANUAL" && (
            <>
              <button type="button" className={small} disabled={pending} onClick={() => void overwrite(s)}>
                덮어쓰기
              </button>
              {actions === "load" && (
                <>
                  <button type="button" className={small} disabled={pending} onClick={() => setRenaming({ id: s.id, name: s.name })}>
                    이름 변경
                  </button>
                  <button type="button" className={small} disabled={pending} onClick={() => void remove(s)}>
                    삭제
                  </button>
                </>
              )}
            </>
          )}
        </span>
      )}
    </li>
  );

  return (
    <>
      <button type="button" className={buttonClass} onClick={() => open("save")}>
        저장
      </button>
      <button type="button" className={buttonClass} onClick={() => open("load")}>
        불러오기
      </button>

      <dialog
        ref={dialog}
        aria-label={mode === "save" ? "저장" : "불러오기"}
        className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-foreground/20 bg-background p-0 text-foreground backdrop:bg-black/40"
      >
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{mode === "save" ? "저장" : "불러오기"}</h2>
            <button type="button" className={small} onClick={() => dialog.current?.close()}>
              닫기
            </button>
          </div>

          {mode === "save" ? (
            <>
              <p className="text-xs text-foreground/60">
                수동 저장 {manual.length}/{list.manualLimit} · 자동 저장은 실행 중 1시간마다 만들어집니다.
              </p>
              <form onSubmit={create} className="flex flex-wrap gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={SAVE_NAME_MAX_LENGTH}
                  placeholder="저장 이름"
                  aria-label="저장 이름"
                  className="min-w-0 flex-1 rounded-md border border-foreground/20 bg-transparent px-3 py-2 text-sm"
                />
                <button type="submit" className={small} disabled={pending || full || name.trim().length === 0}>
                  새로 저장
                </button>
              </form>
              {full && (
                <>
                  <p className="text-xs text-foreground/60">수동 저장이 가득 찼습니다. 아래에서 덮어쓸 저장을 고르거나 불러오기 화면에서 삭제하세요.</p>
                  <ul className="flex flex-col divide-y divide-foreground/10 rounded-md border border-foreground/15">{manual.map((s) => row(s, "overwrite"))}</ul>
                </>
              )}
            </>
          ) : (
            <>
              {!list.canLoad && (
                <p role="status" className="rounded-md bg-foreground/5 px-3 py-2 text-xs">
                  {LOAD_BLOCKED}
                </p>
              )}
              {list.saves.length === 0 ? (
                <p className="text-sm text-foreground/60">아직 저장이 없습니다.</p>
              ) : (
                <ul className="flex max-h-[50vh] flex-col divide-y divide-foreground/10 overflow-y-auto rounded-md border border-foreground/15">{list.saves.map((s) => row(s, "load"))}</ul>
              )}
              <div className="flex flex-col gap-1 rounded-md bg-foreground/[0.03] px-3 py-2">
                <h3 className="text-sm font-semibold">복구</h3>
                {list.recovery ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex-1 text-xs text-foreground/70">
                      마지막 불러오기 직전 상태 · {when(list.recovery.savedAt)} · 장면 {list.recovery.sceneCount}개
                    </span>
                    <button type="button" className={small} disabled={pending || !list.canLoad} onClick={() => list.recovery && void load(list.recovery)}>
                      복구 지점 불러오기
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-foreground/60">저장을 불러오면 그 직전 상태가 여기에 보관됩니다.</p>
                )}
              </div>
            </>
          )}

          {notice && (
            <p role={notice.kind === "error" ? "alert" : "status"} className={`text-sm ${notice.kind === "error" ? "text-red-600" : "text-foreground/70"}`}>
              {notice.text}
            </p>
          )}
        </div>
      </dialog>
    </>
  );
}
