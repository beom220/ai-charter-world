"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ADULTHOOD_MIN_AGE, findBackground, requiresAdulthood } from "../../../../../config/character-backgrounds";
import { CHARACTER_AGE_MAX, CHARACTER_CONTEXT_MAX_LENGTH } from "../../../../../config/limits";
import { EMPTY_CHARACTER_DRAFT } from "@/lib/character-form";
import {
  adulthoodBackgroundIssue,
  CHILDHOOD_REQUIRED_MESSAGE,
  characterInputSchema,
  codePointLength,
  GENDER_INPUTS,
  GENDER_LABEL,
  GENDER_REQUIRED_MESSAGE,
  type CharacterDraft,
  type GenderInput,
  type RandomField,
} from "@/lib/schemas/character";
import { primaryButton } from "../../ui";
import { SettingsLockedNotice, useSettingsEditable } from "../../settings-lock";
import { send } from "../../world-form";
import { BackgroundPicker } from "./background-picker";
import { PersonalitySelect } from "./personality-select";

// 캐릭터 생성·수정 폼 (PRD FR-04). 🎲 전체 랜덤·항목별 랜덤과 필드 잠금을 지원한다.
// 잠금은 클라이언트 상태이며 랜덤 요청에 lockedFields로 보낸다(architecture.md §13).
// 배경(Phase 7-1): 유년기 필수, 성년기는 나이 19세 이상 필수·18세 이하 불가. 나이를 비우면 생성은 성인 자동, 수정은 현재 나이 기준이다.
// 나이를 18세 이하로 바꾸면 성년기 선택을 즉시 비운다. 필수 배경을 고르기 전에는 저장할 수 없다(서버도 같은 규칙으로 거절).
// 성별은 남자·여자만 고른다. 기존 캐릭터의 다른 값은 표시만 하고 저장하려면 다시 골라야 한다.
// 생성 화면 상태 초기화: cacheComponents에서 Next.js는 떠난 화면을 <Activity>로 숨겨 상태를 남긴다.
//   생성 폼은 숨겨질 때(effect cleanup) 입력·잠금·안내를 비워, 다시 들어오면 항상 빈 폼으로 시작한다. 수정 폼은 그대로 둔다.

const input = "rounded-md border border-foreground/20 bg-background px-3 py-1.5 text-sm";
const small = "rounded border border-primary-soft/60 bg-background px-2 py-0.5 text-xs hover:bg-primary/10 disabled:opacity-50";

export function CharacterForm({ worldId, characterId, initial }: { worldId: string; characterId?: string; initial?: CharacterDraft }) {
  const router = useRouter();
  const [draft, setDraft] = useState<CharacterDraft>(initial ?? EMPTY_CHARACTER_DRAFT);
  const [locked, setLocked] = useState<Set<RandomField>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const editable = useSettingsEditable(worldId);

  useEffect(() => {
    if (characterId) return;
    return () => {
      setDraft(EMPTY_CHARACTER_DRAFT);
      setLocked(new Set());
      setNotice(null);
      setBusy(false);
    };
  }, [characterId]);

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
    if (problem) return setNotice({ kind: "error", text: problem });
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
  const genderChosen = (GENDER_INPUTS as readonly string[]).includes(draft.gender ?? "");
  const problem = !genderChosen
    ? GENDER_REQUIRED_MESSAGE
    : !findBackground(draft.childhoodBackgroundId, "CHILDHOOD")
      ? CHILDHOOD_REQUIRED_MESSAGE
      : adulthoodBackgroundIssue(effectiveAge(draft.age) ?? ADULTHOOD_MIN_AGE, draft.adulthoodBackgroundId);

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border border-foreground/15 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primaryButton} onClick={() => randomize()} disabled={busy}>
          🎲 전체 랜덤
        </button>
        <span className="text-xs text-foreground/60">잠근 항목은 유지됩니다.</span>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        {header("성별", "gender")}
        <div role="radiogroup" aria-label="성별" className="flex gap-1.5">
          {GENDER_INPUTS.map((g) => {
            const checked = draft.gender === g;
            return (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={GENDER_LABEL[g]}
                title={GENDER_LABEL[g]}
                onClick={() => set("gender", g)}
                className={`flex h-8 w-10 items-center justify-center rounded-md border ${checked ? GENDER_ICON[g].checked : "border-foreground/20 bg-background opacity-60 hover:bg-hover hover:opacity-100"}`}
              >
                <GenderIcon gender={g} />
              </button>
            );
          })}
        </div>
        {!genderChosen && (
          <span className="text-xs text-foreground/60">{draft.gender ? `기존 값: ${GENDER_LABEL[draft.gender]} — 다시 선택하세요` : "선택하세요"}</span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <label className="flex flex-col gap-1 text-sm">
          {header("이름", "name")}
          <input className={input} value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {header("나이", "age")}
          <input
            className={input}
            type="number"
            min={0}
            max={CHARACTER_AGE_MAX}
            placeholder="비우면 자동"
            value={draft.age ?? ""}
            onChange={(e) => setAge(e.target.value === "" ? null : Number(e.target.value))}
          />
        </label>
      </div>

      <PersonalitySelect value={draft.personalityTags} onChange={(tags) => set("personalityTags", tags)} controls={controls("personalityTags")} />

      <div className="grid gap-4 sm:grid-cols-2">
        <BackgroundPicker stage="CHILDHOOD" value={draft.childhoodBackgroundId} onChange={(id) => set("childhoodBackgroundId", id)} controls={controls("childhoodBackgroundId")} />
        <BackgroundPicker
          stage="ADULTHOOD"
          value={draft.adulthoodBackgroundId}
          onChange={(id) => set("adulthoodBackgroundId", id)}
          disabledReason={adult ? null : `${ADULTHOOD_MIN_AGE - 1}세 이하는 성년기 배경을 설정할 수 없습니다. 나이를 ${ADULTHOOD_MIN_AGE}세 이상으로 하면 선택할 수 있습니다.`}
          controls={controls("adulthoodBackgroundId")}
        />
      </div>

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

      {!editable && <SettingsLockedNotice />}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={primaryButton} disabled={busy || !editable || contextLength > CHARACTER_CONTEXT_MAX_LENGTH || problem !== null}>
          {characterId ? "저장" : "만들기"}
        </button>
        {problem && <span className="text-xs text-foreground/60">{problem}</span>}
        {notice && (
          <p role={notice.kind === "error" ? "alert" : "status"} className={notice.kind === "error" ? "text-sm text-red-600" : "text-sm"}>
            {notice.text}
          </p>
        )}
      </div>
    </form>
  );
}

// 성별 아이콘 버튼 색: 남자 하늘색(사건 파랑과 구분), 여자 로즈 핑크
const GENDER_ICON: Record<GenderInput, { color: string; checked: string }> = {
  MALE: { color: "text-sky-500", checked: "border-sky-500 bg-sky-500/10" },
  FEMALE: { color: "text-primary", checked: "border-primary bg-primary/10" },
};

/** ♂·♀ 기호 (이모지 대체를 피하려고 인라인 SVG) */
function GenderIcon({ gender }: { gender: GenderInput }) {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={GENDER_ICON[gender].color}>
      {gender === "MALE" ? (
        <>
          <circle cx="10" cy="14" r="5" />
          <path d="M13.5 10.5 19 5" />
          <path d="M15 5h4v4" />
        </>
      ) : (
        <>
          <circle cx="12" cy="9" r="5" />
          <path d="M12 14v7" />
          <path d="M9 18h6" />
        </>
      )}
    </svg>
  );
}
