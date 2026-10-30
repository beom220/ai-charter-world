"use client";

import { useCallback, useEffect, useState } from "react";
import { TOAST_DURATION_MS } from "../../config/limits";

// 공용 완료 알림 토스트: 화면 아래 가운데에 TOAST_DURATION_MS(2초) 보였다 사라진다. ✕로 바로 닫을 수 있다.
// 완료(성공) 문구에만 쓰고, 오류는 그 자리에 남긴다. 지우는 것은 JS 타이머가 맡는다(애니메이션 종료 이벤트에 기대지 않는다).

export function useToast(): { toast: { id: number; text: string } | null; show: (text: string) => void; dismiss: () => void } {
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const id = toast?.id;
  useEffect(() => {
    if (id === undefined) return;
    const timer = setTimeout(() => setToast((t) => (t?.id === id ? null : t)), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [id]);
  const show = useCallback((text: string) => setToast({ id: Date.now(), text }), []);
  const dismiss = useCallback(() => setToast(null), []);
  return { toast, show, dismiss };
}

export function Toast({ toast, onDismiss }: { toast: { id: number; text: string } | null; onDismiss: () => void }) {
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div key={toast.id} role="status" className="toast-flash pointer-events-auto flex items-center gap-2 rounded-full border border-primary-soft bg-background py-1.5 pr-1.5 pl-4 text-sm shadow-md">
        <span>{toast.text}</span>
        <button type="button" aria-label="알림 닫기" onClick={onDismiss} className="flex h-6 w-6 items-center justify-center rounded-full text-foreground/50 hover:bg-hover hover:text-foreground">
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
