"use client";

import { useEffect, useState } from "react";
import { SETTINGS_LOCK_POLL_MS } from "../../../config/limits";
import { SETTINGS_LOCKED_MESSAGE, settingsEditable, simulationStateSchema } from "@/lib/simulation-view";

// 설정 수정 가능 여부 (Phase 7-2). 서버(assertSettingsEditable)와 같은 규칙(settingsEditable)으로 화면을 막는다.
// 실행 상태는 다른 탭·Runner가 바꾸므로, 막혀 있는 동안에만 SETTINGS_LOCK_POLL_MS마다 다시 확인한다. 최종 판정은 서버가 한다.

/** worldId가 null이면(새 세계관 만들기) 항상 수정 가능 */
export function useSettingsEditable(worldId: string | null): boolean {
  const [editable, setEditable] = useState(true);

  useEffect(() => {
    if (!worldId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const json: unknown = await fetch(`/api/worlds/${worldId}/simulation/state`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!alive) return;
      const parsed = simulationStateSchema.safeParse((json as { state?: unknown } | null)?.state);
      const next = parsed.success ? settingsEditable(parsed.data) : true; // 확인 실패 시 서버 판정에 맡긴다
      setEditable(next);
      if (!next) timer = setTimeout(check, SETTINGS_LOCK_POLL_MS);
    };
    void check();
    const onFocus = () => {
      clearTimeout(timer);
      void check();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [worldId]);

  return editable;
}

export function SettingsLockedNotice() {
  return (
    <p role="status" className="rounded-md border border-amber-600/40 bg-amber-600/5 px-3 py-2 text-sm">
      {SETTINGS_LOCKED_MESSAGE}
    </p>
  );
}
