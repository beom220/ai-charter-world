"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CHARACTER_CONTEXT_MAX_LENGTH, PERSONALITY_TAGS_MAX, PERSONALITY_TAGS_MIN } from "../../../../../config/limits";
import { PERSONALITY_CATEGORIES, PERSONALITY_TAGS } from "../../../../../config/personality-map";
import {
  characterInputSchema,
  codePointLength,
  GENDER_INPUTS,
  GENDER_LABEL,
  type CharacterDraft,
  type RandomField,
} from "@/lib/schemas/character";
import { button } from "../../ui";
import { send } from "../../world-form";

// 캐릭터 생성·수정 폼 (PRD FR-04). 🎲 전체 랜덤·항목별 랜덤과 필드 잠금을 지원한다.
// 잠금은 클라이언트 상태이며 랜덤 요청에 lockedFields로 보낸다(architecture.md §13).

const input = "rounded-md border border-foreground/20 bg-transparent px-3 py-2";
const small = "rounded border border-foreground/20 px-2 py-0.5 text-xs hover:bg-foreground/5 disabled:opacity-50";

const EMPTY: CharacterDraft = { name: "", gender: "AUTO", genderCustom: null, age: null, personalityTags: [], goal: "", characterContext: "" };

export function CharacterForm({ worldId, characterId, initial }: { worldId: string; characterId?: string; initial?: CharacterDraft }) {
  const router = useRouter();
  const [draft, setDraft] = useState<CharacterDraft>(initial ?? EMPTY);
  const [locked, setLocked] = useState<Set<RandomField>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const set = <K extends keyof CharacterDraft>(key: K, value: CharacterDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const toggleLock = (f: RandomField) =>
    setLocked((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  async function randomize(fields?: RandomField[]) {
    setBusy(true);
    setNotice(null);
    try {
      const { ok, json } = await send(`/api/worlds/${worldId}/characters/random`, "POST", { draft, lockedFields: [...locked], fields });
      if (!ok) return setNotice({ kind: "error", text: json?.error?.message ?? "랜덤 생성에 실패했습니다." });
      setDraft(json.draft);
    } catch {
      setNotice({ kind: "error", text: "랜덤 생성에 실패했습니다." });
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const parsed = characterInputSchema.safeParse(draft);
    if (!parsed.success) return setNotice({ kind: "error", text: parsed.error.issues[0]?.message ?? "입력을 확인하세요." });

    setBusy(true);
    try {
      const base = `/api/worlds/${worldId}/characters`;
      const { ok, json } = characterId ? await send(`${base}/${characterId}`, "PATCH", parsed.data) : await send(base, "POST", parsed.data);
      if (!ok) return setNotice({ kind: "error", text: json?.error?.message ?? "요청을 처리하지 못했습니다." });
      if (!characterId) {
        router.push(`/worlds/${worldId}/characters/${json.character.id}`);
        return router.refresh();
      }
      setNotice({ kind: "ok", text: json.changed ? "저장했습니다. 다음 장면부터 반영됩니다." : "변경된 내용이 없습니다." });
      router.refresh();
    } catch {
      setNotice({ kind: "error", text: "요청을 처리하지 못했습니다." });
    } finally {
      setBusy(false);
    }
  }

  /** 필드 제목 옆의 🎲(항목별 랜덤)와 잠금 토글 */
  const controls = (f: RandomField) => (
    <span className="flex gap-1">
      <button type="button" className={small} onClick={() => randomize([f])} disabled={busy || locked.has(f)} aria-label="이 항목 랜덤">
        🎲
      </button>
      <button type="button" className={small} onClick={() => toggleLock(f)} aria-pressed={locked.has(f)} aria-label="잠금">
        {locked.has(f) ? "🔒 잠김" : "🔓"}
      </button>
    </span>
  );

  const header = (label: string, f: RandomField) => (
    <span className="flex items-center justify-between gap-2">
      <span className="font-medium">{label}</span>
      {controls(f)}
    </span>
  );

  const contextLength = codePointLength(draft.characterContext);

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={button} onClick={() => randomize()} disabled={busy}>
          🎲 전체 랜덤
        </button>
        <span className="text-xs text-foreground/60">잠근 항목은 유지됩니다.</span>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        {header("이름", "name")}
        <input className={input} value={draft.name} onChange={(e) => set("name", e.target.value)} />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          {header("성별", "gender")}
          <select className={input} value={draft.gender} onChange={(e) => set("gender", e.target.value as CharacterDraft["gender"])}>
            {GENDER_INPUTS.map((g) => (
              <option key={g} value={g}>
                {GENDER_LABEL[g]}
              </option>
            ))}
          </select>
          {draft.gender === "CUSTOM" && (
            <input className={input} placeholder="성별 직접 입력" value={draft.genderCustom ?? ""} onChange={(e) => set("genderCustom", e.target.value)} />
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {header("나이", "age")}
          <input
            className={input}
            type="number"
            min={0}
            placeholder="비우면 자동"
            value={draft.age ?? ""}
            onChange={(e) => set("age", e.target.value === "" ? null : Number(e.target.value))}
          />
        </label>
      </div>

      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 w-full">
          {header(`성격 (${draft.personalityTags.length}/${PERSONALITY_TAGS_MIN}~${PERSONALITY_TAGS_MAX}개)`, "personalityTags")}
        </legend>
        {PERSONALITY_CATEGORIES.map((category) => (
          <div key={category} className="flex flex-wrap items-center gap-1.5">
            <span className="w-16 shrink-0 text-xs text-foreground/60">{category}</span>
            {PERSONALITY_TAGS.filter((t) => t.category === category).map((t) => {
              const selected = draft.personalityTags.includes(t.code);
              const full = !selected && draft.personalityTags.length >= PERSONALITY_TAGS_MAX;
              return (
                <button
                  key={t.code}
                  type="button"
                  aria-pressed={selected}
                  disabled={full}
                  onClick={() =>
                    set("personalityTags", selected ? draft.personalityTags.filter((c) => c !== t.code) : [...draft.personalityTags, t.code])
                  }
                  className={`rounded-full border px-2.5 py-0.5 text-xs disabled:opacity-40 ${
                    selected ? "border-foreground bg-foreground text-background" : "border-foreground/20 hover:bg-foreground/5"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        ))}
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        {header("목표 (선택)", "goal")}
        <input className={input} value={draft.goal} onChange={(e) => set("goal", e.target.value)} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {header("캐릭터 컨텍스트", "characterContext")}
        <span className="text-foreground/60">배경·말투·가치관 등을 적으세요. AI에게 그대로 전달됩니다.</span>
        <textarea className={`${input} min-h-28`} value={draft.characterContext} onChange={(e) => set("characterContext", e.target.value)} />
        <span className={`text-right text-xs ${contextLength > CHARACTER_CONTEXT_MAX_LENGTH ? "text-red-600" : "text-foreground/60"}`}>
          {contextLength}/{CHARACTER_CONTEXT_MAX_LENGTH}자
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={button} disabled={busy || contextLength > CHARACTER_CONTEXT_MAX_LENGTH}>
          {characterId ? "저장" : "만들기"}
        </button>
        {notice && (
          <p role={notice.kind === "error" ? "alert" : "status"} className={notice.kind === "error" ? "text-sm text-red-600" : "text-sm"}>
            {notice.text}
          </p>
        )}
      </div>
    </form>
  );
}
