"use client";

import { useRef } from "react";
import { BACKGROUND_STAGE_LABEL, backgroundsOf, findBackground, type BackgroundStage } from "../../../../../config/character-backgrounds";

// 캐릭터 배경 단일 선택 모달 (UI 개선). 버튼에 고른 배경 이름이 보이고, 누르면 <dialog>로 단계별 프리셋 전체
// (유년기 20·성년기 24)를 이름·설명과 함께 보여 준다. 하나를 고르면 바로 닫힌다. 등급 라벨은 보이지 않는다(등급·랜덤 확률은 그대로).
// 고정 프리셋만 고를 수 있다(직접 입력 없음).

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
  /** 제목 옆 랜덤·잠금 버튼 */
  controls?: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const selected = findBackground(value, stage);
  const label = BACKGROUND_STAGE_LABEL[stage];

  function choose(id: string) {
    onChange(id);
    dialog.current?.close();
  }

  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="flex items-center gap-2">
        <span className="font-medium">
          {label} 배경 {!disabledReason && <span className="text-xs font-normal text-foreground/60">(필수)</span>}
        </span>
        {!disabledReason && controls}
      </span>
      {disabledReason ? (
        <p className="rounded-md bg-foreground/5 px-3 py-2 text-xs text-foreground/60">{disabledReason}</p>
      ) : (
        <>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => dialog.current?.showModal()}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-foreground/20 bg-background px-3 py-1.5 text-left hover:border-primary-soft hover:bg-primary/5"
          >
            <span className={selected ? "" : "text-foreground/50"}>{selected ? selected.name : `${label} 배경을 선택하세요`}</span>
            <span aria-hidden className="text-primary-text text-xs text-foreground/60">
              변경
            </span>
          </button>
          <p className="text-xs text-foreground/60" aria-live="polite">
            {selected ? selected.description : "과거 경험일 뿐 현재 성격·능력을 정하지는 않습니다."}
          </p>

          <dialog
            ref={dialog}
            aria-label={`${label} 배경 선택`}
            className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-foreground/20 bg-background p-0 text-foreground backdrop:bg-black/40"
          >
            <div className="flex max-h-[80vh] flex-col">
              <div className="flex items-center justify-between gap-2 border-b border-primary-soft/40 bg-pastel-gradient px-4 py-3">
                <h2 className="text-base font-semibold">{label} 배경 선택</h2>
                <button type="button" className="rounded border border-foreground/20 px-2 py-1 text-xs hover:bg-hover" onClick={() => dialog.current?.close()}>
                  닫기
                </button>
              </div>
              <ul role="listbox" aria-label={`${label} 배경`} className="flex flex-col gap-1 overflow-y-auto p-2">
                {backgroundsOf(stage).map((p) => {
                  const active = p.id === value;
                  return (
                    <li key={p.id} role="option" aria-selected={active}>
                      <button
                        type="button"
                        onClick={() => choose(p.id)}
                        className={`flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left ${
                          active ? "border-primary bg-primary/10" : "border-transparent hover:bg-primary/5"
                        }`}
                      >
                        <span className="text-sm font-medium">
                          {active && "✓ "}
                          {p.name}
                        </span>
                        <span className="text-xs text-foreground/60">{p.description}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </dialog>
        </>
      )}
    </div>
  );
}
