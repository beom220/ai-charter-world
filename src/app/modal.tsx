"use client";

import { modalTitle } from "./ui-styles";

// 공용 모달 (<dialog> 래퍼). 모든 모달이 같은 모양이다: 파스텔 머리줄(제목 + ✕ 닫기), 본문 p-4, 선택적 아래 버튼 줄.
// 여닫기는 부르는 쪽이 ref로 showModal()·close()를 직접 부른다(기존 호출 방식 유지). Esc·✕로 닫힌다.

const WIDTH = { sm: "w-[min(20rem,calc(100vw-2rem))]", md: "w-[min(32rem,calc(100vw-2rem))]", lg: "w-[min(36rem,calc(100vw-2rem))]" } as const;

export function Modal({
  ref,
  title,
  label,
  size = "md",
  footer,
  flush = false,
  onClose,
  children,
}: {
    ref?: React.Ref<HTMLDialogElement>;
    title: React.ReactNode;
    /** 화면 낭독기 이름 (제목이 문자열이 아닐 때) */
    label?: string;
    size?: keyof typeof WIDTH;
    /** 아래 버튼 줄 (오른쪽 정렬) */
    footer?: React.ReactNode;
    /** 본문 여백을 빼고 직접 채운다 (목록 모달) */
    flush?: boolean;
    onClose?: () => void;
    children: React.ReactNode;
}) {
  const close = (e: React.MouseEvent<HTMLButtonElement>) => e.currentTarget.closest("dialog")?.close();
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      className={`m-auto ${WIDTH[size]} rounded-lg border border-foreground/20 bg-background p-0 text-foreground backdrop:bg-black/40`}
    >
      <div className="flex max-h-[85vh] flex-col">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-primary-soft/40 bg-pastel-gradient px-4 py-3">
          <h2 className={modalTitle}>{title}</h2>
          <button type="button" aria-label="닫기" onClick={close} className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/60 hover:bg-hover hover:text-foreground">
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className={`min-h-0 flex-1 overflow-y-auto ${flush ? "" : "p-4"}`}>{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-foreground/10 px-4 py-3">{footer}</div>}
      </div>
    </dialog>
  );
}
