"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SAVE_NAME_MAX_LENGTH } from "../../../../config/limits";
import { button } from "../ui";
import { send } from "../world-form";
import { RUNTIME_EVENT, SAVES_EVENT } from "./world-events";

// 세이브 관리 (Phase 6, architecture.md §9). 수동·자동 저장을 한 목록(마지막 저장 시각 내림차순)으로 보여 주고,
// 복구 지점(불러오기 직전 상태)은 아래 '복구' 영역에 따로 둔다.
// - 목록은 서버 기준이다. SSE saves.updated(자동 저장 포함)가 오면 다시 읽는다. 대화 피드는 건드리지 않는다.
// - 불러오기는 확인 후 요청하고, 성공하면 화면 전체를 다시 읽는다(state.replaced로 다른 탭도 같은 일을 한다).
// - 실행 중·일시정지·진행 중 장면이 있으면 불러오기를 막고 종료하라고 안내한다(서버도 409로 막는다).

export type SaveSlot = { id: string; kind: "MANUAL" | "AUTO" | "RECOVERY"; name: string; autoSlot: number | null; savedAt: string; sceneCount: number; characterCount: number };
export type SaveList = { saves: SaveSlot[]; recovery: SaveSlot | null; manualLimit: number; canLoad: boolean };

const when = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" });
const small = "rounded border border-foreground/20 px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50";

export function SavePanel({ worldId, initial }: { worldId: string; initial: SaveList }) {
  const router = useRouter();
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

  const manualCount = list.saves.filter((s) => s.kind === "MANUAL").length;
  const full = manualCount >= list.manualLimit;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (await act(`/api/worlds/${worldId}/saves`, "POST", { name }, "저장했습니다.")) setName("");
  }

  async function load(slot: SaveSlot) {
    const label = slot.kind === "RECOVERY" ? "복구 지점" : `"${slot.name}"`;
    if (!window.confirm(`${label}을(를) 불러올까요?\n현재 진행 상태는 복구 지점으로 보관되고, 대화·감정·관계·기억이 저장 시점으로 바뀝니다.`)) return;
    if (await act(`/api/worlds/${worldId}/saves/${slot.id}/load`, "POST", undefined, "불러왔습니다.")) router.refresh();
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

  return (
    <section className="flex flex-col gap-3 border-t border-foreground/10 pt-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">저장</h2>
        <span className="text-xs text-foreground/60">
          수동 {manualCount}/{list.manualLimit} · 자동 저장은 실행 중 1시간마다
        </span>
      </div>

      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={SAVE_NAME_MAX_LENGTH}
          placeholder="저장 이름"
          aria-label="저장 이름"
          className="min-w-0 flex-1 rounded-md border border-foreground/20 bg-transparent px-3 py-2 text-sm"
        />
        <button type="submit" className={button} disabled={pending || full || name.trim().length === 0}>
          현재 상태 저장
        </button>
      </form>
      {full && <p className="text-xs text-foreground/60">수동 저장이 가득 찼습니다. 기존 저장을 덮어쓰거나 삭제하세요.</p>}
      {!list.canLoad && <p className="text-xs text-foreground/60">실행 중이거나 일시정지 상태에서는 불러올 수 없습니다. 시뮬레이션을 종료한 뒤 불러오세요.</p>}

      {list.saves.length === 0 ? (
        <p className="text-sm text-foreground/60">아직 저장이 없습니다.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-foreground/10 rounded-md border border-foreground/15">
          {list.saves.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className={`rounded px-1.5 py-0.5 text-[11px] ${s.kind === "MANUAL" ? "bg-foreground/10" : "bg-foreground/5 text-foreground/70"}`}>
                {s.kind === "MANUAL" ? "수동" : "자동"}
              </span>
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
                <span className="flex gap-1">
                  <button type="button" className={small} disabled={pending || !list.canLoad} onClick={() => void load(s)}>
                    불러오기
                  </button>
                  {s.kind === "MANUAL" && (
                    <>
                      <button type="button" className={small} disabled={pending} onClick={() => void overwrite(s)}>
                        덮어쓰기
                      </button>
                      <button type="button" className={small} disabled={pending} onClick={() => setRenaming({ id: s.id, name: s.name })}>
                        이름 변경
                      </button>
                      <button type="button" className={small} disabled={pending} onClick={() => void remove(s)}>
                        삭제
                      </button>
                    </>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
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

      {notice && (
        <p role={notice.kind === "error" ? "alert" : "status"} className={`text-sm ${notice.kind === "error" ? "text-red-600" : "text-foreground/70"}`}>
          {notice.text}
        </p>
      )}
    </section>
  );
}
