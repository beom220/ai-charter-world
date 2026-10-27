import Link from "next/link";
import { MAX_ACTIVE_CHARACTERS_PER_WORLD } from "../../../../../config/limits";
import { PERSONALITY_TAGS } from "../../../../../config/personality-map";
import { GENDER_LABEL } from "@/lib/schemas/character";
import type { CharacterView } from "@/server/domain/characters/characters";
import { button, MOOD_LABEL } from "../../ui";

// 세계관 상세의 캐릭터 목록 (활성 캐릭터만). 6명이면 추가 버튼 대신 상한 안내를 보인다.

export const tagLabel = (code: string) => PERSONALITY_TAGS.find((t) => t.code === code)?.label ?? code;

export function genderText(c: Pick<CharacterView, "gender" | "genderCustom">) {
  return c.gender === "CUSTOM" ? (c.genderCustom ?? "") : GENDER_LABEL[c.gender];
}

export function CharacterList({ worldId, characters }: { worldId: string; characters: CharacterView[] }) {
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
          <Link href={`/worlds/${worldId}/characters/new`} className={button}>
            캐릭터 추가
          </Link>
        )}
      </div>
      {characters.length === 0 ? (
        <p className="text-sm text-foreground/70">아직 캐릭터가 없습니다. 대화를 시작하려면 2명 이상 만드세요.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {characters.map((c) => (
            <li key={c.id}>
              <Link href={`/worlds/${worldId}/characters/${c.id}`} className="flex flex-col gap-1 rounded-md border border-foreground/15 p-3 hover:bg-foreground/5">
                <span className="font-medium break-all">{c.name}</span>
                <span className="text-xs text-foreground/60">
                  {genderText(c)} · {c.age ?? "?"}세 · 기분 {c.emotion ? MOOD_LABEL[c.emotion.mood] : "-"}
                </span>
                <span className="text-xs text-foreground/70">{c.personalityTags.map(tagLabel).join(", ")}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
