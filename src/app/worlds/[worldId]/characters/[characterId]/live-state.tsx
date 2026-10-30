"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { abnormalConditions, emotionView, formatScore, relationView, type IntensityLevel, type RelationValues, type StatusTone } from "@/lib/character-status";
import type { DiscomfortLevel, InjuryLevel, ThermalCauseValue } from "@/lib/condition-labels";
import { formatWorldTime } from "@/lib/world-clock";
import { MOOD_LABEL } from "../../../ui";
import { send } from "../../../world-form";
import { moodExpression } from "@/lib/avatars";
import { Avatar } from "../../../avatar";
import { CHARACTERS_EVENT, emitWorldEvent } from "../../world-events";

// 캐릭터 상세의 감정·관계·기억 (Phase 5-5 화면, Phase 6 실시간 갱신).
// - 세계관 SSE를 구독해 scene.committed가 오면 /characters/[id]/state를 다시 읽는다. 상태 변화 수치는 메인 피드에 보이지 않는다.
// - 요청마다 번호를 붙여 가장 최근 요청의 응답만 반영한다(응답 순서가 뒤집혀도 오래된 값으로 덮어쓰지 않음).
// - state.replaced(불러오기)면 페이지 전체를 서버에서 다시 그린다(프로필이 바뀌었거나 캐릭터가 없어졌을 수 있음).
// - 신체 상태(Phase 7-2-2): 온도 불편·고통·부상·생존. 사망하면 원인·장면·월드 시각을 보이고, 페이지를 다시 그려 수정 폼을 닫는다.
// - 프로필: 맨 위에 큰 일러스트를 현재 감정 표정으로 보인다(lib/avatars.ts moodExpression, 감정 없음·모르는 값은 neutral). 다시 읽으면 함께 바뀐다.
//   장면 커밋·재동기화를 받으면 상단 고정 프로필에도 CHARACTERS_EVENT로 알린다(별도 구독 없음).
// - 표시(게임형 상태창): 막대 채움·단계·점수·색 톤 변환은 src/lib/character-status.ts. 이모지는 쓰지 않는다.
//   "현재 상태" 카드는 좌우 2열(모바일은 위아래). 왼쪽은 감정 → 신체 이상(정상이 아닌 항목만) → 사망을 0부터 채우는 막대로,
//   오른쪽은 최근 감정 변화(장면별 EmotionChange)를 보인다. 요인별 감정 영향 점수 데이터는 없어서 만들지 않는다.
//   관계는 이 캐릭터 → 상대 한 방향만 [단계 | 이름 | 점수(호감·신뢰·존중 평균)]로 보인다(반대 방향은 상대 캐릭터 상세에서).
//   기억은 최신순(서버에서 정렬)이며 처음 몇 개만 보이고 "더 보기"로 펼친다.

export type LiveMemory = {
  id: string;
  kind: string;
  acquisition: string;
  importance: number;
  content: string;
  aboutName: string | null;
  sceneSeq: number | null;
  worldSeconds: number | null;
};
export type LiveCondition = {
  thermalCause: ThermalCauseValue;
  thermalLevel: DiscomfortLevel;
  painLevel: DiscomfortLevel;
  painCause: string | null;
  injury: InjuryLevel;
  injuryCause: string | null;
  vital: "ALIVE" | "DEAD";
  deathCause: string | null;
  deathSceneSeq: number | null;
  deathWorldSeconds: number | null;
};
export type LiveEmotionChange = {
  id: string;
  fromMood: string;
  toMood: string;
  dIntensity: number;
  sceneSeq: number | null;
  sceneTitle: string | null;
  worldSeconds: number | null;
};
type LiveState = {
  emotion: { mood: string; intensity: number } | null;
  condition: LiveCondition;
  relations: { otherId: string; otherName: string; outgoing: RelationValues; incoming: RelationValues }[];
  memories: LiveMemory[];
  emotionChanges: LiveEmotionChange[];
};

const panel = "flex flex-col gap-1.5 rounded-md border p-3";
const heading = "border-b border-foreground/10 pb-1.5 text-sm font-semibold";
const TONE_TEXT: Record<StatusTone, string> = { positive: "text-tone-positive", negative: "text-tone-negative", neutral: "text-tone-neutral" };
/** 강도 색 단계 → 막대 채움·문구 색 (Tailwind가 찾을 수 있게 클래스 이름을 그대로 쓴다). 0은 채움 없음 */
const INTENSITY_FILL: Record<IntensityLevel, string> = { 0: "bg-bar-track", 1: "bg-intensity-1", 2: "bg-intensity-2", 3: "bg-intensity-3", 4: "bg-intensity-4", 5: "bg-intensity-5" };
const INTENSITY_TEXT: Record<IntensityLevel, string> = {
  0: "text-intensity-text-1",
  1: "text-intensity-text-1",
  2: "text-intensity-text-2",
  3: "text-intensity-text-3",
  4: "text-intensity-text-4",
  5: "text-intensity-text-5",
};
/** 기억은 처음 이만큼만 보이고 나머지는 "더 보기"로 펼친다 */
const MEMORY_PREVIEW_COUNT = 5;
const MEMORY_KIND_LABEL: Record<string, string> = {
  EVENT: "사건",
  PROMISE: "약속",
  CONFESSION: "고백",
  CONFLICT: "갈등",
  SECRET: "비밀",
  IMPRESSION: "인상",
  OTHER: "기타",
};
const ACQUISITION_LABEL: Record<string, string> = { WITNESSED: "직접 겪음", TOLD: "전해 들음", OBSERVED: "관찰" };

export function CharacterLiveState({
  worldId,
  characterId,
  characterName,
  avatarId,
  eventCursor,
  initial,
}: {
  worldId: string;
  characterId: string;
  characterName: string;
  avatarId: string | null;
  eventCursor: string;
  initial: LiveState;
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const latest = useRef(0);
  const dead = useRef(initial.condition.vital === "DEAD");
  const [showAllMemories, setShowAllMemories] = useState(false);

  /** 최신 값 다시 읽기. 늦게 도착한 이전 요청의 응답은 버린다 */
  const reload = useCallback(async () => {
    const seq = ++latest.current;
    const { ok, json } = await send(`/api/worlds/${worldId}/characters/${characterId}/state`, "GET").catch(() => ({ ok: false, json: null }));
    if (ok && seq === latest.current) {
      const next = json as LiveState;
      if (next.condition.vital === "DEAD" && !dead.current) {
        dead.current = true;
        router.refresh(); // 사망: 수정 폼을 닫는다
      }
      setState(next);
    }
  }, [worldId, characterId, router]);

  useEffect(() => {
    // 보기 전용 구독(watch=1): 상세 화면을 보고 있다고 시뮬레이션이 계속 돌지 않게 대화 화면 연결로 세지 않는다
    const es = new EventSource(`/api/worlds/${worldId}/simulation/stream?watch=1&lastEventId=${encodeURIComponent(eventCursor)}`);
    const changed = () => {
      void reload();
      emitWorldEvent(CHARACTERS_EVENT);
    };
    es.addEventListener("scene.committed", changed);
    es.addEventListener("sync.required", changed);
    es.addEventListener("state.replaced", () => router.refresh());
    return () => es.close();
  }, [worldId, eventCursor, reload, router]);

  const abnormal = state.condition.vital === "DEAD" ? [] : abnormalConditions(state.condition);
  const emotion = state.emotion && emotionView(state.emotion.mood, state.emotion.intensity);
  const memories = showAllMemories ? state.memories : state.memories.slice(0, MEMORY_PREVIEW_COUNT);
  return (
    <div className="flex flex-col gap-3 text-status-text">
      <div className="flex items-center gap-4">
        <Avatar
          avatarId={avatarId}
          expression={moodExpression(state.emotion?.mood)}
          name={characterName}
          size={112}
          eager
          className={`border-2 ${state.condition.vital === "DEAD" ? "border-red-600/40" : "border-primary-soft"}`}
        />
        <p className="flex flex-col text-sm">
          <span className="text-xs text-foreground/60">현재 감정</span>
          <span className="font-semibold">{state.emotion ? (MOOD_LABEL[state.emotion.mood] ?? state.emotion.mood) : "기록 없음"}</span>
        </p>
      </div>
      <section className={`${panel} ${state.condition.vital === "DEAD" ? "border-red-600/40" : "border-foreground/15"}`}>
        <h2 className={heading}>현재 상태</h2>
        <div className="grid gap-3 sm:grid-cols-2 sm:gap-5">
          <div className="flex min-w-0 flex-col gap-2.5">
            {state.emotion && emotion ? (
              <MeterRow
                label={MOOD_LABEL[state.emotion.mood] ?? state.emotion.mood}
                text={emotion.text}
                level={emotion.level}
                meter={<Meter percent={emotion.value} level={emotion.level} valueText={emotion.text} />}
              />
            ) : (
              <p className="text-sm text-foreground/60">감정 기록 없음</p>
            )}
            {abnormal.map((a) => (
              <MeterRow
                key={a.key}
                label={a.label}
                text={a.text}
                level={a.level}
                detail={a.detail}
                meter={<Meter step={a.step} steps={a.steps} level={a.level} valueText={a.text} />}
              />
            ))}
            {state.condition.vital === "DEAD" && (
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-red-600">사망</span>
                <p className="text-xs break-words text-status-text/70">
                  {state.condition.deathCause ?? "원인 미상"}
                  {state.condition.deathSceneSeq !== null ? ` · 장면 #${state.condition.deathSceneSeq}` : ""}
                  {state.condition.deathWorldSeconds !== null ? ` · ${formatWorldTime(state.condition.deathWorldSeconds)}` : ""}
                </p>
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 border-t border-foreground/10 pt-3 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-5">
            <h3 className="text-xs font-semibold text-status-text/80">최근 감정 변화</h3>
            {state.emotionChanges.length === 0 ? (
              <p className="text-xs text-foreground/60">아직 장면에서 감정이 바뀐 기록이 없습니다.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {state.emotionChanges.map((e) => (
                  <li key={e.id} className="flex flex-col text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 break-words">{e.sceneTitle ?? "기록이 삭제된 장면"}</span>
                      <span className="shrink-0 text-xs text-tone-neutral tabular-nums">강도 {formatScore(e.dIntensity)}</span>
                    </div>
                    <span className="text-xs text-status-text/60">
                      {e.fromMood === e.toMood ? (MOOD_LABEL[e.toMood] ?? e.toMood) : `${MOOD_LABEL[e.fromMood] ?? e.fromMood} → ${MOOD_LABEL[e.toMood] ?? e.toMood}`}
                      {e.sceneSeq !== null && ` · 장면 #${e.sceneSeq}`}
                      {e.worldSeconds !== null && ` · ${formatWorldTime(e.worldSeconds)}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-foreground/50">장면별 감정 강도 변화 기록입니다. 요인별 긍정·부정 영향 점수는 아직 기록되지 않습니다.</p>
          </div>
        </div>
      </section>
      <section className={`${panel} border-foreground/15`}>
        <h2 className={heading}>관계</h2>
        {state.relations.length === 0 ? (
          <p className="text-sm text-foreground/60">다른 캐릭터가 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {state.relations.map((r) => {
              const v = relationView(r.outgoing);
              return (
                <li key={r.otherId} className="flex items-baseline gap-3 text-sm">
                  <span className={`w-16 shrink-0 font-medium ${TONE_TEXT[v.tone]}`}>{v.stage}</span>
                  <Link href={`/worlds/${worldId}/characters/${r.otherId}`} className="min-w-0 flex-1 break-all hover:underline">
                    {r.otherName}
                  </Link>
                  <span className={`shrink-0 text-right font-medium tabular-nums ${TONE_TEXT[v.tone]}`}>{formatScore(v.score)}</span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-[11px] text-foreground/50">
          {characterName}이(가) 상대를 어떻게 보는지입니다(점수는 호감·신뢰·존중 평균, -100~+100). 상대가 {characterName}을(를) 어떻게 보는지는 상대 캐릭터 화면에서 볼 수 있습니다.
        </p>
      </section>
      <section className={`${panel} border-foreground/15`}>
        <h2 className={heading}>최근 기억</h2>
        {state.memories.length === 0 ? (
          <p className="text-sm text-foreground/60">대화가 진행되면 이 캐릭터가 중요하게 여긴 일이 여기에 기록됩니다.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {memories.map((m) => (
              <li key={m.id} className="flex flex-col">
                <span className="break-words whitespace-pre-wrap">{m.content}</span>
                <span className="text-xs text-status-text/60">
                  {MEMORY_KIND_LABEL[m.kind] ?? m.kind} · {ACQUISITION_LABEL[m.acquisition] ?? m.acquisition}
                  {m.aboutName && ` · ${m.aboutName}에 대해`}
                  {m.sceneSeq !== null && ` · 장면 #${m.sceneSeq}`}
                  {m.worldSeconds !== null && ` · ${formatWorldTime(m.worldSeconds)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {state.memories.length > MEMORY_PREVIEW_COUNT && (
          <button type="button" onClick={() => setShowAllMemories((v) => !v)} className="self-start text-xs text-primary-text underline">
            {showAllMemories ? "접기" : `더 보기 (${state.memories.length - MEMORY_PREVIEW_COUNT}개)`}
          </button>
        )}
        <p className="text-[11px] text-foreground/50">AI가 생성한 허구의 캐릭터 기억입니다. 이 캐릭터만 아는 내용이며 다른 캐릭터의 대화에는 쓰이지 않습니다.</p>
      </section>
    </div>
  );
}

/** [이름 | 단계] 한 줄, 그 아래 막대, 설명은 막대 아래 작은 글씨. 단계 문구는 강도 색 단계의 진한 글자색 */
function MeterRow({ label, text, level, meter, detail }: { label: string; text: string; level: IntensityLevel; meter: React.ReactNode; detail?: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 font-medium break-words">{label}</span>
        <span className={`shrink-0 text-xs font-medium ${INTENSITY_TEXT[level]}`}>{text}</span>
      </div>
      {meter}
      {detail && <p className="text-xs break-words text-status-text/70">{detail}</p>}
    </div>
  );
}

/**
 * 0 → 최대치로 왼쪽부터 채우는 막대. 색은 강도 색 단계(level, 로즈 핑크 5단계)로 길이와 함께 강도를 나타낸다. percent: 실제 값 비율(감정 강도).
 * step/steps: 단계형 데이터는 단계 수만큼 칸을 나눠 채운다(가짜 정밀 수치를 만들지 않는다). 화면 낭독기에는 단계 문구로 읽힌다.
 */
function Meter({ percent, step, steps, level, valueText }: { percent?: number; step?: number; steps?: number; level: IntensityLevel; valueText: string }) {
  if (steps !== undefined && step !== undefined) {
    return (
      <span role="meter" aria-valuemin={0} aria-valuemax={steps} aria-valuenow={step} aria-valuetext={valueText} className="flex h-2.5 gap-0.5">
        {Array.from({ length: steps }, (_, i) => (
          <span key={i} className={`flex-1 first:rounded-l-full last:rounded-r-full ${i < step ? INTENSITY_FILL[level] : "bg-bar-track"}`} />
        ))}
      </span>
    );
  }
  const value = Math.min(100, Math.max(0, percent ?? 0));
  return (
    <span role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={valueText} className="block h-2.5 overflow-hidden rounded-full bg-bar-track">
      <span className={`block h-full rounded-full ${INTENSITY_FILL[level]}`} style={{ width: `${value}%` }} />
    </span>
  );
}
