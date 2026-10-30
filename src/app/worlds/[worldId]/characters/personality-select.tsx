"use client";

import { useRef } from "react";
import { PERSONALITY_TAGS_MAX, PERSONALITY_TAGS_MIN } from "../../../../../config/limits";
import { PERSONALITY_TAGS } from "../../../../../config/personality-map";
import { togglePersonalityTag } from "@/lib/character-form";

// 성격 다중 선택 모달 (UI 개선, 배경 선택 모달과 같은 방식). 버튼에 고른 성격이 보이고, 누르면 <dialog>로
// 분류 구분 없는 전체 태그를 보여 준다. 항목을 누를 때마다 선택·해제되고(다중 선택), [완료]나 닫기로 닫는다.
// 최대 개수에 도달하면 나머지 항목은 고를 수 없다(데이터 구조·서버 검증은 그대로).

export function PersonalitySelect({ value, onChange, controls }: { value: string[]; onChange: (tags: string[]) => void; controls?: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const labelOf = (code: string) => PERSONALITY_TAGS.find((t) => t.code === code)?.label ?? code;
  const full = value.length >= PERSONALITY_TAGS_MAX;
  const count = `${value.length}/${PERSONALITY_TAGS_MIN}~${PERSONALITY_TAGS_MAX}개`;

  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="flex items-center gap-2">
        <span className="font-medium">
          성격 <span className="text-xs font-normal text-foreground/60">({count})</span>
        </span>
        {controls}
      </span>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-foreground/20 bg-background px-3 py-1.5 text-left hover:border-primary-soft hover:bg-primary/5"
      >
        <span className={value.length ? "" : "text-foreground/50"}>{value.length ? value.map(labelOf).join(", ") : "성격을 선택하세요"}</span>
        <span aria-hidden className="shrink-0 text-xs text-primary-text">
          변경
        </span>
      </button>
      <p className="text-xs text-foreground/60">
        {PERSONALITY_TAGS_MIN}~{PERSONALITY_TAGS_MAX}개를 고르세요. 여러 개를 함께 선택할 수 있습니다.
      </p>

      <dialog
        ref={dialog}
        aria-label="성격 선택"
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-foreground/20 bg-background p-0 text-foreground backdrop:bg-black/40"
      >
        <div className="flex max-h-[80vh] flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-primary-soft/40 bg-pastel-gradient px-4 py-3">
            <h2 className="text-base font-semibold">
              성격 선택 <span className="text-xs font-normal text-foreground/60">({count})</span>
            </h2>
            <button type="button" className="rounded border border-foreground/20 px-2 py-1 text-xs hover:bg-hover" onClick={() => dialog.current?.close()}>
              닫기
            </button>
          </div>
          {full && <p className="px-4 pt-2 text-xs text-foreground/60">최대 {PERSONALITY_TAGS_MAX}개까지 고를 수 있습니다. 바꾸려면 하나를 해제하세요.</p>}
          <ul role="listbox" aria-multiselectable="true" aria-label="성격" className="grid gap-1 overflow-y-auto p-2 sm:grid-cols-2">
            {PERSONALITY_TAGS.map((t) => {
              const selected = value.includes(t.code);
              const disabled = !selected && full;
              return (
                <li key={t.code} role="option" aria-selected={selected} aria-disabled={disabled}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(togglePersonalityTag(value, t.code))}
                    className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left disabled:opacity-40 ${
                      selected ? "border-primary bg-primary/10 font-medium" : "border-transparent hover:bg-primary/5"
                    }`}
                  >
                    <span aria-hidden className="w-4">
                      {selected ? "✓" : ""}
                    </span>
                    {t.label}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end border-t border-foreground/10 px-4 py-3">
            <button type="button" className="rounded-md border border-foreground/20 px-4 py-1.5 text-sm font-medium hover:bg-hover" onClick={() => dialog.current?.close()}>
              완료
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
