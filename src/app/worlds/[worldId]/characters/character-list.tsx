import Link from "next/link";
import { Avatar } from "../../avatar";
import { MAX_ACTIVE_CHARACTERS_PER_WORLD } from "../../../../../config/limits";
import { PERSONALITY_TAGS } from "../../../../../config/personality-map";
import { conditionBadges } from "@/lib/condition-labels";
import { GENDER_LABEL } from "@/lib/schemas/character";
import type { CharacterView } from "@/server/domain/characters/characters";
import { MOOD_LABEL, primaryButton } from "../../ui";
import { ConfirmDeleteButton } from "../../world-form";

// 세계관 상세의 캐릭터 목록 (활성 캐릭터만). 6명이면 추가 버튼 대신 상한 안내를 보인다. 생성 화면 하단에서는 추가 버튼을 숨긴다(showAdd).
// 사망자도 목록에 남아 슬롯을 차지한다(Phase 7-2-2). 신체 상태가 정상이 아니면 배지로 보인다.
// 카드 오른쪽 위 ✕로 바로 삭제한다(상세 화면 삭제와 같은 확인 대화상자·API·실행 중 잠금). 보고 있던 캐릭터를 지우면 캐릭터 탭으로 간다.

export const tagLabel = (code: string) => PERSONALITY_TAGS.find((t) => t.code === code)?.label ?? code;

export function genderText(c: Pick<CharacterView, "gender" | "genderCustom">) {
  return c.gender === "CUSTOM" ? (c.genderCustom ?? "") : GENDER_LABEL[c.gender];
}

export function CharacterList({
  worldId,
  characters,
  showAdd = true,
  currentId,
}: {
  worldId: string;
  characters: CharacterView[];
  showAdd?: boolean;
  /** 상세 화면에서 보고 있는 캐릭터 (강조) */
  currentId?: string;
}) {
  const full = characters.length >= MAX_ACTIVE_CHARACTERS_PER_WORLD;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          캐릭터 ({characters.length}/{MAX_ACTIVE_CHARACTERS_PER_WORLD})
        </h2>
        {full ? (
          <p className="text-sm text-foreground/70">캐릭터는 최대 {MAX_ACTIVE_CHARACTERS_PER_WORLD}명입니다. 추가하려면 기존 캐릭터를 삭제하세요.</p>
        ) : (
          showAdd && (
            <Link href={`/worlds/${worldId}/characters/new`} className={primaryButton}>
              캐릭터 추가
            </Link>
          )
        )}
      </div>
      {characters.length === 0 ? (
        <p className="text-sm text-foreground/70">아직 캐릭터가 없습니다. 대화를 시작하려면 2명 이상 만드세요.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {characters.map((c) => (
            <li key={c.id} className="relative">
              <Link
                href={`/worlds/${worldId}/characters/${c.id}`}
                aria-current={c.id === currentId ? "page" : undefined}
                className={`flex items-start gap-3 rounded-md border p-3 pr-10 hover:bg-hover ${c.id === currentId ? "border-primary bg-primary/5" : "border-foreground/15"}`}
              >
                <Avatar avatarId={c.avatarId} name={c.name} size={44} />
                <span className="flex min-w-0 flex-col gap-1">
                <span className="font-medium break-all">
                  {c.name}
                  {conditionBadges(c.condition).map((b) => (
                    <span key={b} className={`ml-1 rounded px-1.5 py-0.5 text-[11px] font-normal ${b === "사망" ? "bg-red-600/10 text-red-600" : "bg-amber-600/10"}`}>
                      {b}
                    </span>
                  ))}
                </span>
                <span className="text-xs text-foreground/60">
                  {genderText(c)} · {c.age ?? "?"}세 · 기분 {c.emotion ? MOOD_LABEL[c.emotion.mood] : "-"}
                </span>
                <span className="text-xs text-foreground/70">{c.personalityTags.map(tagLabel).join(", ")}</span>
                </span>
              </Link>
              <div className="absolute top-2 right-2">
                <ConfirmDeleteButton
                  label={`${c.name} 삭제`}
                  title="캐릭터를 삭제할까요?"
                  path={`/api/worlds/${worldId}/characters/${c.id}`}
                  redirectTo={c.id === currentId ? `/worlds/${worldId}/characters` : null}
                  lockWorldId={worldId}
                  trigger={{
                    className: "flex h-7 w-7 items-center justify-center rounded-md text-foreground/50 hover:bg-red-600/10 hover:text-red-600 disabled:opacity-40",
                    content: (
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden>
                        <path d="M6 6l12 12M18 6 6 18" />
                      </svg>
                    ),
                  }}
                >
                  <strong>{c.name}</strong>은(는) 이후 대화에 참가하지 않습니다. 지난 대화·기억·관계 기록은 남고, 과거 대사에는 &quot;삭제된 캐릭터&quot;로 표시됩니다.
                </ConfirmDeleteButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
