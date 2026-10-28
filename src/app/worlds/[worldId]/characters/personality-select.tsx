"use client";

import { useEffect, useRef, useState } from "react";
import { PERSONALITY_TAGS_MAX, PERSONALITY_TAGS_MIN } from "../../../../../config/limits";
import { PERSONALITY_TAGS } from "../../../../../config/personality-map";
import { togglePersonalityTag } from "@/lib/character-form";

// 성격 다중 선택 (UI 개선). 분류 구분 없이 전체 태그를 하나의 드롭다운 목록으로 보여 준다.
// 고른 태그는 위에 칩으로 보이고 ✕로 지운다. 최대 개수에 도달하면 나머지 항목은 고를 수 없다(데이터 구조·서버 검증은 그대로).

export function PersonalitySelect({ value, onChange, controls }: { value: string[]; onChange: (tags: string[]) => void; controls?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const labelOf = (code: string) => PERSONALITY_TAGS.find((t) => t.code === code)?.label ?? code;

  // 목록 밖을 누르거나 Esc를 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative flex flex-col gap-1 text-sm">
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium">
          성격 ({value.length}/{PERSONALITY_TAGS_MIN}~{PERSONALITY_TAGS_MAX}개)
        </span>
        {controls}
      </span>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-foreground/20 px-2 py-1.5">
        {value.length === 0 && <span className="text-foreground/50">선택한 성격이 여기에 표시됩니다</span>}
        {value.map((code) => (
          <span key={code} className="flex items-center gap-1 rounded-full bg-foreground/10 px-2.5 py-0.5 text-xs">
            {labelOf(code)}
            <button type="button" aria-label={`${labelOf(code)} 제거`} onClick={() => onChange(value.filter((c) => c !== code))} className="text-foreground/60 hover:text-foreground">
              ✕
            </button>
          </span>
        ))}
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="ml-auto rounded border border-foreground/20 px-2 py-0.5 text-xs hover:bg-foreground/5"
        >
          {open ? "닫기 ▲" : "선택 ▼"}
        </button>
      </div>
      {open && (
        <ul role="listbox" aria-multiselectable="true" aria-label="성격" className="absolute top-full right-0 left-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-foreground/20 bg-background p-1 shadow-lg">
          {PERSONALITY_TAGS.map((t) => {
            const selected = value.includes(t.code);
            const disabled = !selected && value.length >= PERSONALITY_TAGS_MAX;
            return (
              <li key={t.code} role="option" aria-selected={selected} aria-disabled={disabled}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(togglePersonalityTag(value, t.code))}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left disabled:opacity-40 ${selected ? "bg-foreground/10 font-medium" : "hover:bg-foreground/5"}`}
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
      )}
    </div>
  );
}
