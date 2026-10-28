"use client";

import { useState } from "react";
import {
  BACKGROUND_RARITIES,
  BACKGROUND_RARITY_LABEL,
  BACKGROUND_STAGE_LABEL,
  backgroundsOf,
  findBackground,
  type BackgroundRarity,
  type BackgroundStage,
} from "../../../../../config/character-backgrounds";

// 캐릭터 배경 선택 (Phase 7-1). 고정 프리셋만 고를 수 있다(직접 입력·미설정 없음).
// 일반/특수/희귀 탭으로 나눠 카드로 보여 주고(44개를 한 번에 나열하지 않음), 선택한 배경의 이름·설명을 위에 미리 보여 준다.

const RARITY_STYLE: Record<BackgroundRarity, string> = {
  COMMON: "text-foreground/70",
  UNCOMMON: "text-sky-600 dark:text-sky-400",
  RARE: "text-amber-600 dark:text-amber-400",
};

export function BackgroundPicker({
  stage,
  value,
  onChange,
  disabledReason,
  controls,
}: {
  stage: BackgroundStage;
  value: string | null;
  onChange: (id: string) => void;
  /** 있으면 선택할 수 없고 이 안내만 보여 준다 (18세 이하 성년기) */
  disabledReason?: string | null;
  /** 제목 옆 🎲·잠금 버튼 */
  controls?: React.ReactNode;
}) {
  const selected = findBackground(value, stage);
  const [tab, setTab] = useState<BackgroundRarity>(selected?.rarity ?? "COMMON");
  const label = BACKGROUND_STAGE_LABEL[stage];

  return (
    <fieldset className="flex flex-col gap-2 text-sm">
      <legend className="mb-1 flex w-full items-center justify-between gap-2">
        <span className="font-medium">
          {label} 배경 {!disabledReason && <span className="text-xs font-normal text-foreground/60">(필수)</span>}
        </span>
        {!disabledReason && controls}
      </legend>

      {disabledReason ? (
        <p className="rounded-md bg-foreground/5 px-3 py-2 text-xs text-foreground/60">{disabledReason}</p>
      ) : (
        <>
          <p className={`rounded-md px-3 py-2 text-xs ${selected ? "bg-foreground/5" : "border border-dashed border-foreground/30 text-foreground/60"}`} aria-live="polite">
            {selected ? (
              <>
                <span className={`mr-1 ${RARITY_STYLE[selected.rarity]}`}>[{BACKGROUND_RARITY_LABEL[selected.rarity]}]</span>
                <span className="font-semibold">{selected.name}</span> — {selected.description}
              </>
            ) : (
              `${label} 배경을 선택하세요. 과거 경험일 뿐 현재 성격·능력을 정하지는 않습니다.`
            )}
          </p>
          <div role="tablist" aria-label={`${label} 배경 등급`} className="flex gap-1">
            {BACKGROUND_RARITIES.map((r) => (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={tab === r}
                onClick={() => setTab(r)}
                className={`rounded px-3 py-1 text-xs ${tab === r ? "bg-foreground/10 font-semibold" : "hover:bg-foreground/5"} ${RARITY_STYLE[r]}`}
              >
                {BACKGROUND_RARITY_LABEL[r]} ({backgroundsOf(stage, r).length})
              </button>
            ))}
          </div>
          <div role="tabpanel" className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
            {backgroundsOf(stage, tab).map((p) => {
              const active = p.id === value;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChange(p.id)}
                  className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left ${
                    active ? "border-foreground bg-foreground/10" : "border-foreground/15 hover:bg-foreground/5"
                  }`}
                >
                  <span className="text-sm font-medium">
                    {active && "✓ "}
                    {p.name}
                  </span>
                  <span className="text-xs text-foreground/60">{p.description}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </fieldset>
  );
}
