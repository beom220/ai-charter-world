"use client";

import { AVATAR_EXHAUSTED_MESSAGE, avatarIdsFor } from "@/lib/avatars";
import { Avatar } from "../../avatar";

// 프로필 일러스트 선택 (캐릭터 생성·편집). 성별에 맞는 목록(여 17·남 6)만 보이고, 목록·미리보기는 항상 neutral 표정이다.
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
  const ids = avatarIdsFor(gender);
  const exhausted = ids.length > 0 && ids.every((id) => used.has(id));
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium">프로필 일러스트</span>
        {controls}
      </span>
      {ids.length === 0 ? (
        <span className="text-xs text-foreground/60">성별을 먼저 선택하면 고를 수 있습니다.</span>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-center sm:gap-1">
            <Avatar avatarId={value} name={name || "?"} size={96} className={`border-2 ${value ? "border-primary" : "border-foreground/15"}`} eager />
            <span className="text-xs text-foreground/60">{value ? "미리보기" : "선택 안 됨"}</span>
          </div>
          <div role="radiogroup" aria-label="프로필 일러스트" className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(3.5rem,1fr))] gap-1.5">
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
                  onClick={() => onChange(id)}
                  className={`relative flex aspect-square items-center justify-center rounded-lg border-2 p-0.5 ${
                    checked ? "border-primary bg-primary/10" : taken ? "border-transparent opacity-40" : "border-transparent hover:border-primary-soft hover:bg-hover"
                  }`}
                >
                  <Avatar avatarId={id} name={id} size={48} />
                  {taken && <span className="absolute inset-x-0 bottom-0 rounded-b-md bg-foreground/70 text-[10px] leading-4 text-background">사용 중</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {exhausted && !value && <span className="text-xs text-red-600">{AVATAR_EXHAUSTED_MESSAGE}</span>}
    </div>
  );
}
