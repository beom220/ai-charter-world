"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ADULTHOOD_MIN_AGE, findBackground, requiresAdulthood } from "../../../../../config/character-backgrounds";
import { CHARACTER_CONTEXT_MAX_LENGTH, PERSONALITY_TAGS_MAX, PERSONALITY_TAGS_MIN } from "../../../../../config/limits";
import { PERSONALITY_CATEGORIES, PERSONALITY_TAGS } from "../../../../../config/personality-map";
import {
  adulthoodBackgroundIssue,
  CHILDHOOD_REQUIRED_MESSAGE,
  characterInputSchema,
  codePointLength,
  GENDER_INPUTS,
  GENDER_LABEL,
  type CharacterDraft,
  type RandomField,
} from "@/lib/schemas/character";
import { button } from "../../ui";
import { send } from "../../world-form";
import { BackgroundPicker } from "./background-picker";

// 캐릭터 생성·수정 폼 (PRD FR-04). 🎲 전체 랜덤·항목별 랜덤과 필드 잠금을 지원한다.
// 잠금은 클라이언트 상태이며 랜덤 요청에 lockedFields로 보낸다(architecture.md §13).
// 배경(Phase 7-1): 유년기 필수, 성년기는 나이 19세 이상 필수·18세 이하 불가. 나이를 비우면 생성은 성인 자동, 수정은 현재 나이 기준이다.
// 나이를 18세 이하로 바꾸면 성년기 선택을 즉시 비운다. 필수 배경을 고르기 전에는 저장할 수 없다(서버도 같은 규칙으로 거절).

const input = "rounded-md border border-foreground/20 bg-transparent px-3 py-2";
const small = "rounded border border-foreground/20 px-2 py-0.5 text-xs hover:bg-foreground/5 disabled:opacity-50";

const EMPTY: CharacterDraft = {
  name: "",
  gender: "AUTO",
  genderCustom: null,
  age: null,
  personalityTags: [],
  goal: "",
  characterContext: "",
  childhoodBackgroundId: null,
  adulthoodBackgroundId: null,
};

export function CharacterForm({ worldId, characterId, initial }: { worldId: string; characterId?: string; initial?: CharacterDraft }) {
  const router = useRouter();
  const [draft, setDraft] = useState<CharacterDraft>(initial ?? EMPTY);
  const [locked, setLocked] = useState<Set<RandomField>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const set = <K extends keyof CharacterDraft>(key: K, value: CharacterDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  /** 저장될 나이: 비우면 생성은 성인 자동, 수정은 현재 나이 */
  const effectiveAge = (age: number | null) => age ?? initial?.age ?? null;
  const isAdult = (age: number | null) => {
    const a = effectiveAge(age);
    return a === null || requiresAdulthood(a);
  };
  const setAge = (age: number | null) => setDraft((d) => ({ ...d, age, adulthoodBackgroundId: isAdult(age) ? d.adulthoodBackgroundId : null }));
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
      const next = json.draft as CharacterDraft;
      // 나이 규칙이 잠금보다 우선한다: 잠근 성년기 배경이 비워졌으면 알린다
      if (locked.has("adulthoodBackgroundId") && draft.adulthoodBackgroundId && !next.adulthoodBackgroundId) {
        setNotice({ kind: "error", text: `나이가 ${ADULTHOOD_MIN_AGE - 1}세 이하가 되어 잠근 성년기 배경을 비웠습니다.` });
      }
      setDraft(next);
    } catch {
      setNotice({ kind: "error", text: "랜덤 생성에 실패했습니다." });
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (backgroundProblem) return setNotice({ kind: "error", text: backgroundProblem });
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
  const adult = isAdult(draft.age);
  const ageForRule = effectiveAge(draft.age);
  const backgroundProblem = !findBackground(draft.childhoodBackgroundId, "CHILDHOOD")
    ? CHILDHOOD_REQUIRED_MESSAGE
    : adulthoodBackgroundIssue(ageForRule ?? ADULTHOOD_MIN_AGE, draft.adulthoodBackgroundId);

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
            onChange={(e) => setAge(e.target.value === "" ? null : Number(e.target.value))}
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

      <BackgroundPicker
        key={`c-${draft.childhoodBackgroundId ?? "none"}`} // 랜덤으로 바뀌면 그 등급 탭을 연다
        stage="CHILDHOOD"
        value={draft.childhoodBackgroundId}
        onChange={(id) => set("childhoodBackgroundId", id)}
        controls={controls("childhoodBackgroundId")}
      />
      <BackgroundPicker
        key={`a-${draft.adulthoodBackgroundId ?? "none"}`}
        stage="ADULTHOOD"
        value={draft.adulthoodBackgroundId}
        onChange={(id) => set("adulthoodBackgroundId", id)}
        disabledReason={adult ? null : `${ADULTHOOD_MIN_AGE - 1}세 이하는 성년기 배경을 설정할 수 없습니다. 나이를 ${ADULTHOOD_MIN_AGE}세 이상으로 하면 선택할 수 있습니다.`}
        controls={controls("adulthoodBackgroundId")}
      />

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
        <button type="submit" className={button} disabled={busy || contextLength > CHARACTER_CONTEXT_MAX_LENGTH || backgroundProblem !== null}>
          {characterId ? "저장" : "만들기"}
        </button>
        {backgroundProblem && <span className="text-xs text-foreground/60">{backgroundProblem}</span>}
        {notice && (
          <p role={notice.kind === "error" ? "alert" : "status"} className={notice.kind === "error" ? "text-sm text-red-600" : "text-sm"}>
            {notice.text}
          </p>
        )}
      </div>
    </form>
  );
}
