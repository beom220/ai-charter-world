"use client";

import {
  BACKGROUND_RARITY_LABEL,
  BACKGROUND_STAGE_LABEL,
  backgroundsOf,
  findBackground,
  type BackgroundStage,
} from "../../../../../config/character-backgrounds";

// 캐릭터 배경 선택 (Phase 7-1, UI 개선). 단계별 프리셋 전체(유년기 20·성년기 24)를 하나의 단일 선택 Select로 보여 주고,
// 고른 배경의 설명을 아래에 표시한다. 고정 프리셋만 고를 수 있다(직접 입력 없음). 첫 항목은 안내용이며 값으로 저장되지 않는다.

const field = "w-full rounded-md border border-foreground/20 bg-background px-3 py-2";

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
  const label = BACKGROUND_STAGE_LABEL[stage];
  const id = `background-${stage}`;

  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="font-medium">
          {label} 배경 {!disabledReason && <span className="text-xs font-normal text-foreground/60">(필수)</span>}
        </label>
        {!disabledReason && controls}
      </span>
      {disabledReason ? (
        <p className="rounded-md bg-foreground/5 px-3 py-2 text-xs text-foreground/60">{disabledReason}</p>
      ) : (
        <>
          <select id={id} className={field} value={selected?.id ?? ""} onChange={(e) => e.target.value && onChange(e.target.value)} required>
            <option value="" disabled>
              {label} 배경을 선택하세요
            </option>
            {backgroundsOf(stage).map((p) => (
              <option key={p.id} value={p.id}>
                [{BACKGROUND_RARITY_LABEL[p.rarity]}] {p.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-foreground/60" aria-live="polite">
            {selected ? selected.description : "과거 경험일 뿐 현재 성격·능력을 정하지는 않습니다."}
          </p>
        </>
      )}
    </div>
  );
}
