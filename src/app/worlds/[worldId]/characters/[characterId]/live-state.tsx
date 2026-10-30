"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { abnormalConditions, emotionView, formatScore, relationView, type RelationValues, type StatusTone } from "@/lib/character-status";
import type { DiscomfortLevel, InjuryLevel, ThermalCauseValue } from "@/lib/condition-labels";
import { formatWorldTime } from "@/lib/world-clock";
import { MOOD_LABEL } from "../../../ui";
import { send } from "../../../world-form";

// 캐릭터 상세의 감정·관계·기억 (Phase 5-5 화면, Phase 6 실시간 갱신).
// - 세계관 SSE를 구독해 scene.committed가 오면 /characters/[id]/state를 다시 읽는다. 상태 변화 수치는 메인 피드에 보이지 않는다.
// - 요청마다 번호를 붙여 가장 최근 요청의 응답만 반영한다(응답 순서가 뒤집혀도 오래된 값으로 덮어쓰지 않음).
// - state.replaced(불러오기)면 페이지 전체를 서버에서 다시 그린다(프로필이 바뀌었거나 캐릭터가 없어졌을 수 있음).
// - 신체 상태(Phase 7-2-2): 온도 불편·고통·부상·생존. 사망하면 원인·장면·월드 시각을 보이고, 페이지를 다시 그려 수정 폼을 닫는다.
// - 표시(게임형 정보창): 막대 없이 [이름 | 단계·점수] 행과 그 아래 작은 설명으로 보인다. 단계·점수·색 톤 변환은 src/lib/character-status.ts.
//   "현재 상태" 카드 하나에 감정 → 신체 이상(정상이 아닌 항목만, 모두 정상이면 없음) → 사망 순으로 보인다. 감정·신체에는 점수를 붙이지 않는다. 이모지는 쓰지 않는다.
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
type LiveState = {
  emotion: { mood: string; intensity: number } | null;
  condition: LiveCondition;
  relations: { otherId: string; otherName: string; outgoing: RelationValues; incoming: RelationValues }[];
  memories: LiveMemory[];
};

const panel = "flex flex-col gap-1.5 rounded-md border p-3";
const heading = "border-b border-foreground/10 pb-1.5 text-sm font-semibold";
const TONE_TEXT: Record<StatusTone, string> = { positive: "text-tone-positive", negative: "text-tone-negative", neutral: "text-tone-neutral" };
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
  eventCursor,
  initial,
}: {
  worldId: string;
  characterId: string;
  characterName: string;
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
    es.addEventListener("scene.committed", () => void reload());
    es.addEventListener("sync.required", () => void reload());
    es.addEventListener("state.replaced", () => router.refresh());
    return () => es.close();
  }, [worldId, eventCursor, reload, router]);

  const abnormal = state.condition.vital === "DEAD" ? [] : abnormalConditions(state.condition);
  const emotion = state.emotion && emotionView(state.emotion.mood, state.emotion.intensity);
  const memories = showAllMemories ? state.memories : state.memories.slice(0, MEMORY_PREVIEW_COUNT);
  return (
    <div className="flex flex-col gap-3 text-status-text">
      <section className={`${panel} ${state.condition.vital === "DEAD" ? "border-red-600/40" : "border-foreground/15"}`}>
        <h2 className={heading}>현재 상태</h2>
        {state.emotion && emotion ? (
          <StatusRow label={MOOD_LABEL[state.emotion.mood] ?? state.emotion.mood} value={emotion.text} tone={emotion.tone} />
        ) : (
          <p className="text-sm text-foreground/60">감정 기록 없음</p>
        )}
        {abnormal.map((a) => (
          <StatusRow key={a.key} label={a.label} value={a.text} tone="negative" detail={a.detail} />
        ))}
        {state.condition.vital === "DEAD" && (
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-red-600">사망</span>
            <p className="pl-3 text-xs break-words text-status-text/70">
              {state.condition.deathCause ?? "원인 미상"}
              {state.condition.deathSceneSeq !== null ? ` · 장면 #${state.condition.deathSceneSeq}` : ""}
              {state.condition.deathWorldSeconds !== null ? ` · ${formatWorldTime(state.condition.deathWorldSeconds)}` : ""}
            </p>
          </div>
        )}
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

/** 이름 왼쪽, 단계 오른쪽. 설명은 행 아래 작은 글씨 */
function StatusRow({ label, value, tone, detail }: { label: string; value: string; tone: StatusTone; detail?: string | null }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 font-medium break-words">{label}</span>
        <span className={`shrink-0 font-medium ${TONE_TEXT[tone]}`}>{value}</span>
      </div>
      {detail && <p className="pl-3 text-xs break-words text-status-text/70">{detail}</p>}
    </div>
  );
}
