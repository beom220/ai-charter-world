"use client";

import { useRef } from "react";
import { AVATAR_EXHAUSTED_MESSAGE, avatarIdsFor } from "@/lib/avatars";
import { Avatar } from "../../avatar";

// 프로필 일러스트 선택 모달 (캐릭터 생성·편집, 배경 선택 모달과 같은 방식). 폼에는 미리보기만 보이고,
// 미리보기(일러스트)를 누르면 <dialog>로 성별에 맞는 목록(여 17·남 6)을 보여 준다. 하나를 고르면 바로 닫힌다. 목록·미리보기는 항상 neutral 표정이다.
// 같은 세계관의 다른 활성 캐릭터가 쓰는 일러스트는 "사용 중"으로 표시하고 고를 수 없다(서버도 저장 때 거절한다).

export function AvatarPicker({
  gender,
  value,
  used,
  name,
  onChange,
  controls,
}: {
  gender: string | null;
  value: string | null;
  /** 다른 활성 캐릭터가 쓰는 일러스트 (자기 자신 제외) */
  used: ReadonlySet<string>;
  name: string;
  onChange: (avatarId: string) => void;
  controls: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = avatarIdsFor(gender);
  const exhausted = ids.length > 0 && ids.every((id) => used.has(id));

  function choose(id: string) {
    onChange(id);
    dialog.current?.close();
  }

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="flex items-center gap-2">
        <span className="font-medium">
          프로필 일러스트 <span className="text-xs font-normal text-foreground/60">(필수)</span>
        </span>
        {controls}
      </span>
      {ids.length === 0 ? (
        <span className="text-xs text-foreground/60">성별을 먼저 선택하면 고를 수 있습니다.</span>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label={value ? "프로필 일러스트 변경" : "프로필 일러스트 선택"}
              onClick={() => dialog.current?.showModal()}
              className="rounded-full outline-offset-2 hover:opacity-90"
            >
              <Avatar avatarId={value} name={name || "?"} size={72} className={`border-2 ${value ? "border-primary hover:border-primary-strong" : "border-dashed border-foreground/30"}`} eager />
            </button>
            <span className="text-xs text-foreground/60">{value ? "일러스트를 누르면 바꿀 수 있습니다." : "일러스트를 눌러 선택하세요."}</span>
          </div>
          {exhausted && !value && <span className="text-xs text-red-600">{AVATAR_EXHAUSTED_MESSAGE}</span>}

          <dialog
            ref={dialog}
            aria-label="프로필 일러스트 선택"
            className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-foreground/20 bg-background p-0 text-foreground backdrop:bg-black/40"
          >
            <div className="flex max-h-[80vh] flex-col">
              <div className="flex items-center justify-between gap-2 border-b border-primary-soft/40 bg-pastel-gradient px-4 py-3">
                <h2 className="text-base font-semibold">프로필 일러스트 선택</h2>
                <button type="button" className="rounded border border-foreground/20 px-2 py-1 text-xs hover:bg-hover" onClick={() => dialog.current?.close()}>
                  닫기
                </button>
              </div>
              {exhausted && <p className="px-4 pt-3 text-xs text-red-600">{AVATAR_EXHAUSTED_MESSAGE}</p>}
              <div role="radiogroup" aria-label="프로필 일러스트" className="grid grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-2 overflow-y-auto p-3">
                {ids.map((id, i) => {
                  const checked = value === id;
                  const taken = used.has(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      aria-label={`일러스트 ${i + 1}${taken ? " (사용 중)" : ""}`}
                      disabled={taken}
                      onClick={() => choose(id)}
                      className={`relative flex aspect-square items-center justify-center rounded-lg border-2 p-1 ${
                        checked ? "border-primary bg-primary/10" : taken ? "border-transparent opacity-40" : "border-transparent hover:border-primary-soft hover:bg-hover"
                      }`}
                    >
                      <Avatar avatarId={id} name={id} size={64} eager />
                      {taken && <span className="absolute inset-x-0 bottom-0 rounded-b-md bg-foreground/70 text-[10px] leading-4 text-background">사용 중</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </dialog>
        </>
      )}
    </div>
  );
}
