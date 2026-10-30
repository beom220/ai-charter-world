"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ADULTHOOD_MIN_AGE, findBackground, requiresAdulthood } from "../../../../../config/character-backgrounds";
import { CHARACTER_AGE_MAX, CHARACTER_CONTEXT_MAX_LENGTH, TOAST_DURATION_MS } from "../../../../../config/limits";
import { AVATAR_EXHAUSTED_MESSAGE, AVATAR_IN_USE_MESSAGE, AVATAR_REQUIRED_MESSAGE, isAvatarForGender, pickAvailableAvatar } from "@/lib/avatars";
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
import { AvatarPicker } from "./avatar-picker";
import { BackgroundPicker } from "./background-picker";
import { PersonalitySelect } from "./personality-select";

// 캐릭터 생성·수정 폼 (PRD FR-04). 전체 랜덤·항목별 랜덤과 필드 잠금을 지원한다.
// 잠금은 클라이언트 상태이며 랜덤 요청에 lockedFields로 보낸다(architecture.md §13).
// 배경(Phase 7-1): 유년기 필수, 성년기는 나이 19세 이상 필수·18세 이하 불가. 나이를 비우면 생성은 성인 자동, 수정은 현재 나이 기준이다.
// 나이를 18세 이하로 바꾸면 성년기 선택을 즉시 비운다. 필수 배경을 고르기 전에는 저장할 수 없다(서버도 같은 규칙으로 거절).
// 완료 알림(만들기·저장)은 화면 아래에 2초 보였다 사라지는 토스트(✕로 바로 닫기), 오류는 저장 버튼 옆에 남는다.
// 성별은 남자·여자만 고른다. 기존 캐릭터의 다른 값은 표시만 하고 저장하려면 다시 골라야 한다.
// 프로필 일러스트: 성별에 맞고 같은 세계관의 다른 활성 캐릭터가 쓰지 않는 것만 고른다(목록·미리보기는 neutral).
//   성별을 고르거나 바꿔 지금 일러스트가 맞지 않으면 남은 것 중 하나를 랜덤으로 미리 고른다(사용자가 바꿀 수 있다).
//   기존 캐릭터의 일러스트가 비어 있거나 쓸 수 없으면(이전 데이터) 첫 번째 남은 일러스트를 미리 고른다(서버 렌더와 같게 랜덤 아님). 저장 전까지 DB는 바뀌지 않는다.
//   남은 일러스트가 없으면 중복을 허용하지 않고 안내한다. 최종 중복 검사는 서버가 저장 때 한다(AVATAR_IN_USE).
// 생성 화면 상태 초기화: cacheComponents에서 Next.js는 떠난 화면을 <Activity>로 숨겨 상태를 남긴다.
//   생성 폼은 숨겨질 때(effect cleanup) 입력·잠금·안내를 비우고, 다시 들어오면 전체 랜덤 한 번으로 미리 채운다. 수정 폼은 그대로 둔다.

const input = "rounded-md border border-foreground/20 bg-background px-3 py-1.5 text-sm";
const small = "flex h-6 items-center gap-1 rounded border border-primary-soft/60 bg-background px-1.5 text-xs hover:bg-primary/10 disabled:opacity-50";

export function CharacterForm({
  worldId,
  characterId,
  initial,
  usedAvatarIds,
}: {
  worldId: string;
  characterId?: string;
  initial?: CharacterDraft;
  /** 같은 세계관의 다른 활성 캐릭터(사망자 포함, 자기 자신 제외)가 쓰는 일러스트 */
  usedAvatarIds: string[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<CharacterDraft>(() => {
    if (!initial) return EMPTY_CHARACTER_DRAFT;
    const usable = isAvatarForGender(initial.avatarId, initial.gender) && !usedAvatarIds.includes(initial.avatarId!);
    return usable || !initial.gender ? initial : { ...initial, avatarId: pickAvailableAvatar(initial.gender, usedAvatarIds, () => 0) };
  });
  const [locked, setLocked] = useState<Set<RandomField>>(new Set());
  const [busy, setBusy] = useState(false);
  // 오류는 폼 안에 남기고, 완료(ok) 알림은 화면 아래에 잠깐 나타났다 사라진다(id가 바뀌면 같은 문구도 다시 보인다)
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string; id?: number } | null>(null);
  const flash = (text: string) => setNotice({ kind: "ok", text, id: Date.now() });
  const flashId = notice?.kind === "ok" ? notice.id : undefined;
  // 완료 알림은 TOAST_DURATION_MS 뒤에 지운다(애니메이션 종료 이벤트에 기대지 않는다). 새 알림이 오면 타이머를 다시 건다
  useEffect(() => {
    if (flashId === undefined) return;
    const timer = setTimeout(() => setNotice((n) => (n?.id === flashId ? null : n)), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [flashId]);
  const editable = useSettingsEditable(worldId);
  const usedAvatars = new Set(usedAvatarIds);
  const avatarUsable = (id: string | null, gender: string | null) => isAvatarForGender(id, gender) && !usedAvatarIds.includes(id!);

  // 생성 화면에 들어올 때마다 전체 랜덤을 한 번 실행해 값을 미리 채운다(일러스트도 사용 가능한 것 중에서).
  // 응답 전에 사용자가 이미 입력을 시작했으면(빈 초안이 아니면) 덮어쓰지 않는다. 실패해도 빈 폼으로 그대로 쓸 수 있다.
  useEffect(() => {
    if (characterId) return;
    let cancelled = false;
    send(`/api/worlds/${worldId}/characters/random`, "POST", { draft: EMPTY_CHARACTER_DRAFT, lockedFields: [] })
      .then(({ ok, json }) => {
        if (!cancelled && ok) setDraft((d) => (d === EMPTY_CHARACTER_DRAFT ? (json.draft as CharacterDraft) : d));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      setDraft(EMPTY_CHARACTER_DRAFT);
      setLocked(new Set());
      setNotice(null);
      setBusy(false);
    };
  }, [characterId, worldId]);

  const set = <K extends keyof CharacterDraft>(key: K, value: CharacterDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  /** 저장될 나이: 비우면 생성은 성인 자동, 수정은 현재 나이 */
  const effectiveAge = (age: number | null) => age ?? initial?.age ?? null;
  const isAdult = (age: number | null) => {
    const a = effectiveAge(age);
    return a === null || requiresAdulthood(a);
  };
  /** 성별 선택: 지금 일러스트가 새 성별에 맞지 않으면 남은 것 중 하나를 미리 고른다 */
  const setGender = (gender: GenderInput) =>
    setDraft((d) => ({ ...d, gender, avatarId: avatarUsable(d.avatarId, gender) ? d.avatarId : pickAvailableAvatar(gender, usedAvatarIds) }));
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
      const { ok, json } = await send(`/api/worlds/${worldId}/characters/random`, "POST", { draft, lockedFields: [...locked], fields, characterId });
      if (!ok) return setNotice({ kind: "error", text: json?.error?.message ?? "랜덤 생성에 실패했습니다." });
      const next = json.draft as CharacterDraft;
      // 나이 규칙이 잠금보다 우선한다: 잠근 성년기 배경이 비워졌으면 알린다
      if (locked.has("adulthoodBackgroundId") && draft.adulthoodBackgroundId && !next.adulthoodBackgroundId) {
        setNotice({ kind: "error", text: `나이가 ${ADULTHOOD_MIN_AGE - 1}세 이하가 되어 잠근 성년기 배경을 비웠습니다.` });
      } else if (next.gender && !next.avatarId) {
        setNotice({ kind: "error", text: AVATAR_EXHAUSTED_MESSAGE });
      } else if (locked.has("avatarId") && draft.avatarId && next.avatarId !== draft.avatarId) {
        setNotice({ kind: "error", text: "성별에 맞지 않거나 사용 중이 된 잠긴 일러스트를 다시 골랐습니다." });
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
        // 생성 후에는 화면을 옮기지 않고 빈 폼으로 돌려, 아래 캐릭터 목록만 새로 읽는다
        setDraft(EMPTY_CHARACTER_DRAFT);
        setLocked(new Set());
        flash(`${parsed.data.name} 캐릭터를 만들었습니다.`);
        return router.refresh();
      }
      flash(json.changed ? "저장했습니다. 다음 장면부터 반영됩니다." : "변경된 내용이 없습니다.");
      router.refresh();
    } catch {
      setNotice({ kind: "error", text: "요청을 처리하지 못했습니다." });
    } finally {
      setBusy(false);
    }
  }

  /** 필드 제목 옆의 항목별 랜덤(주사위)과 잠금 토글(자물쇠) */
  const controls = (f: RandomField) => (
    <span className="flex gap-1">
      <button type="button" className={`group ${small} text-primary-text`} onClick={() => randomize([f])} disabled={busy || locked.has(f)} aria-label="이 항목 랜덤" title="이 항목 랜덤">
        <DiceIcon size={14} rolling={busy} />
      </button>
      <button
        type="button"
        className={`${small} ${locked.has(f) ? "border-primary bg-primary/10 text-primary-text" : "text-foreground/50"}`}
        onClick={() => toggleLock(f)}
        aria-pressed={locked.has(f)}
        aria-label="잠금"
        title={locked.has(f) ? "잠김 (랜덤에서 유지)" : "잠금"}
      >
        <LockIcon locked={locked.has(f)} size={14} />
        {locked.has(f) && <span>잠김</span>}
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
      : (adulthoodBackgroundIssue(effectiveAge(draft.age) ?? ADULTHOOD_MIN_AGE, draft.adulthoodBackgroundId) ??
        (!draft.avatarId ? AVATAR_REQUIRED_MESSAGE : !avatarUsable(draft.avatarId, draft.gender) ? AVATAR_IN_USE_MESSAGE : null));

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border border-foreground/15 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`group ${primaryButton} flex items-center gap-1.5`} onClick={() => randomize()} disabled={busy}>
          <DiceIcon size={16} rolling={busy} />
          전체 랜덤
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
                onClick={() => setGender(g)}
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

      <AvatarPicker
        gender={genderChosen ? draft.gender : null}
        value={draft.avatarId}
        used={usedAvatars}
        name={draft.name}
        onChange={(id) => set("avatarId", id)}
        controls={controls("avatarId")}
      />

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
        <span className="text-foreground/60">배경·말투·가치관 등을 적으세요.</span>
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
        {notice?.kind === "error" && (
          <p role="alert" className="text-sm text-red-600">
            {notice.text}
          </p>
        )}
      </div>
      {notice?.kind === "ok" && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          <div key={notice.id} role="status" className="toast-flash pointer-events-auto flex items-center gap-2 rounded-full border border-primary-soft bg-background py-1.5 pr-1.5 pl-4 text-sm shadow-md">
            <span>{notice.text}</span>
            <button
              type="button"
              aria-label="알림 닫기"
              onClick={() => setNotice(null)}
              className="flex h-6 w-6 items-center justify-center rounded-full text-foreground/50 hover:bg-hover hover:text-foreground"
            >
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </div>
      )}
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

/**
 * 굴러가는 주사위 (랜덤). 이모지 대신 인라인 SVG: 기울어진 주사위 + 왼쪽 움직임 선.
 * 버튼에 마우스를 올리면 더 기울고(group-hover), 랜덤 요청 중(rolling)에는 계속 돈다(동작 줄이기 설정이면 멈춤).
 */
function DiceIcon({ size, rolling = false }: { size: number; rolling?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="overflow-visible">
      <path d="M1.5 9.5h3.5M0.5 13.5h3M1.5 17.5h3.5" strokeWidth={1.8} opacity={0.55} />
      <g
        className={`origin-[14.5px_12px] transition-transform duration-200 group-hover:-rotate-[32deg] ${rolling ? "motion-safe:animate-spin" : ""}`}
      >
        <g transform="rotate(-16 14.5 12)">
          <rect x="7.5" y="5" width="14" height="14" rx="3.2" />
          <circle cx="11" cy="8.5" r="1.35" fill="currentColor" stroke="none" />
          <circle cx="14.5" cy="12" r="1.35" fill="currentColor" stroke="none" />
          <circle cx="18" cy="15.5" r="1.35" fill="currentColor" stroke="none" />
        </g>
      </g>
    </svg>
  );
}

/** 자물쇠 (잠김·풀림). 이모지 대신 인라인 SVG */
function LockIcon({ locked, size }: { locked: boolean; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4.5" y="11" width="15" height="10" rx="2" />
      <path d={locked ? "M8 11V7.5a4 4 0 0 1 8 0V11" : "M8 11V7.5a4 4 0 0 1 7.5-1.9"} />
    </svg>
  );
}
