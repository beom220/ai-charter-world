"use client";

import { useEffect, useRef, useState } from "react";
import { PERSONALITY_TAGS_MAX, PERSONALITY_TAGS_MIN } from "../../../../../config/limits";
import { PERSONALITY_TAGS } from "../../../../../config/personality-map";
import { togglePersonalityTag } from "@/lib/character-form";

// 성격 다중 선택 드롭다운 (UI 개선). 입력란을 누르면 분류 구분 없는 전체 태그 목록이 체크박스로 펼쳐진다.
// 고른 태그는 입력란 안에 칩으로 보이고 ✕로 바로 지운다. 최대 개수에 도달하면 나머지 항목은 고를 수 없다(데이터 구조·서버 검증은 그대로).

export function PersonalitySelect({ value, onChange, controls }: { value: string[]; onChange: (tags: string[]) => void; controls?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const labelOf = (code: string) => PERSONALITY_TAGS.find((t) => t.code === code)?.label ?? code;
  const full = value.length >= PERSONALITY_TAGS_MAX;

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
    <div className="flex flex-col gap-1 text-sm">
      <span className="flex items-center justify-between gap-2">
        <span id="personality-label" className="font-medium">
          성격 ({value.length}/{PERSONALITY_TAGS_MIN}~{PERSONALITY_TAGS_MAX}개)
        </span>
        {controls}
      </span>
      <div ref={box} className="relative">
        <div
          role="combobox"
          tabIndex={0}
          aria-labelledby="personality-label"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls="personality-options"
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className="flex min-h-10 cursor-pointer flex-wrap items-center gap-1.5 rounded-md border border-foreground/20 bg-background py-1.5 pr-8 pl-2"
        >
          {value.length === 0 && <span className="px-1 text-foreground/50">성격을 선택하세요</span>}
          {value.map((code) => (
            <span key={code} className="flex items-center gap-1 rounded-full bg-foreground/10 px-2.5 py-0.5 text-xs">
              {labelOf(code)}
              <button
                type="button"
                aria-label={`${labelOf(code)} 제거`}
                onClick={(e) => {
                  e.stopPropagation(); // 칩 제거는 드롭다운을 열고 닫지 않는다
                  onChange(value.filter((c) => c !== code));
                }}
                className="text-foreground/60 hover:text-foreground"
              >
                ✕
              </button>
            </span>
          ))}
          <span aria-hidden className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-foreground/60">
            {open ? "▲" : "▼"}
          </span>
        </div>
        {open && (
          <ul
            id="personality-options"
            role="listbox"
            aria-multiselectable="true"
            aria-labelledby="personality-label"
            className="absolute top-full right-0 left-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-foreground/20 bg-background p-1 shadow-lg"
          >
            {full && <li className="px-2 py-1 text-xs text-foreground/60">최대 {PERSONALITY_TAGS_MAX}개까지 고를 수 있습니다. 바꾸려면 하나를 해제하세요.</li>}
            {PERSONALITY_TAGS.map((t) => {
              const selected = value.includes(t.code);
              const disabled = !selected && full;
              return (
                <li key={t.code} role="option" aria-selected={selected} aria-disabled={disabled}>
                  <label className={`flex w-full items-center gap-2 rounded px-2 py-1.5 ${disabled ? "opacity-40" : "cursor-pointer hover:bg-foreground/5"} ${selected ? "font-medium" : ""}`}>
                    <input type="checkbox" checked={selected} disabled={disabled} onChange={() => onChange(togglePersonalityTag(value, t.code))} />
                    {t.label}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
