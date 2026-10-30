"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { injuryBar, intensityBar, moodVisual, painBar, relationBar, thermalBar, type RelationValues } from "@/lib/character-status";
import type { DiscomfortLevel, InjuryLevel, ThermalCauseValue } from "@/lib/condition-labels";
import { formatWorldTime } from "@/lib/world-clock";
import { MOOD_LABEL } from "../../../ui";
import { send } from "../../../world-form";
import { StatusBar } from "./status-bar";

// 캐릭터 상세의 감정·관계·기억 (Phase 5-5 화면, Phase 6 실시간 갱신).
// - 세계관 SSE를 구독해 scene.committed가 오면 /characters/[id]/state를 다시 읽는다. 상태 변화 수치는 메인 피드에 보이지 않는다.
// - 요청마다 번호를 붙여 가장 최근 요청의 응답만 반영한다(응답 순서가 뒤집혀도 오래된 값으로 덮어쓰지 않음).
// - state.replaced(불러오기)면 페이지 전체를 서버에서 다시 그린다(프로필이 바뀌었거나 캐릭터가 없어졌을 수 있음).
// - 신체 상태(Phase 7-2-2): 온도 불편·고통·부상·생존. 사망하면 원인·장면·월드 시각을 보이고, 페이지를 다시 그려 수정 폼을 닫는다.
// - 표시(게임형 상태창): 감정·관계·신체 상태를 칸 막대(status-bar.tsx)로 보인다. 단계·색 변환은 src/lib/character-status.ts.
//   관계는 이 캐릭터 → 상대 한 방향만 보인다(반대 방향은 상대 캐릭터 상세에서). 수치는 화면에 직접 내보이지 않는다.

export type LiveMemory = { id: string; kind: string; acquisition: string; importance: number; content: string; aboutName: string | null };
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

const panel = "flex flex-col gap-2 rounded-md border border-foreground/15 p-4";
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

  const thermal = thermalBar(state.condition.thermalCause, state.condition.thermalLevel);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <section className={panel}>
        <h2 className="text-sm font-semibold">현재 감정</h2>
        {state.emotion ? (
          <>
            <p className="flex items-center gap-2 text-base font-semibold">
              <span aria-hidden className="text-2xl leading-none">
                {moodVisual(state.emotion.mood).icon}
              </span>
              {MOOD_LABEL[state.emotion.mood] ?? state.emotion.mood}
            </p>
            <StatusBar label="강도" bar={intensityBar(state.emotion.mood, state.emotion.intensity)} />
          </>
        ) : (
          <p className="text-sm text-foreground/60">기록 없음</p>
        )}
      </section>
      <section className={`${panel} ${state.condition.vital === "DEAD" ? "border-red-600/40" : ""}`}>
        <h2 className="text-sm font-semibold">신체 상태</h2>
        {state.condition.vital === "DEAD" ? (
          <p className="text-sm">
            <span className="font-semibold text-red-600">사망</span> — {state.condition.deathCause ?? "원인 미상"}
            <span className="text-xs text-foreground/60">
              {state.condition.deathSceneSeq !== null ? ` · 장면 #${state.condition.deathSceneSeq}` : ""}
              {state.condition.deathWorldSeconds !== null ? ` · ${formatWorldTime(state.condition.deathWorldSeconds)}` : ""}
            </span>
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <StatusBar label="온도 불편감" icon={thermal.cause === "COLD" ? "❄️" : thermal.cause === "HEAT" ? "🔥" : "🌡️"} bar={thermal} />
            <StatusBar label="고통" icon="💢" bar={painBar(state.condition.painLevel)} detail={state.condition.painCause} />
            <StatusBar label="부상" icon="🩹" bar={injuryBar(state.condition.injury)} detail={state.condition.injuryCause} />
          </div>
        )}
      </section>
      <section className={`${panel} sm:col-span-2`}>
        <h2 className="text-sm font-semibold">관계</h2>
        {state.relations.length === 0 ? (
          <p className="text-sm text-foreground/60">다른 캐릭터가 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {state.relations.map((r) => (
              <li key={r.otherId}>
                <StatusBar
                  label={
                    <Link href={`/worlds/${worldId}/characters/${r.otherId}`} className="truncate font-medium underline">
                      {r.otherName}
                    </Link>
                  }
                  bar={relationBar(r.outgoing)}
                />
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-foreground/50">
          {characterName}이(가) 상대를 어떻게 보는지입니다(호감·신뢰·존중을 합친 5단계). 상대가 {characterName}을(를) 어떻게 보는지는 상대 캐릭터 화면에서 볼 수 있습니다.
        </p>
      </section>
      <section className={`${panel} sm:col-span-2`}>
        <h2 className="text-sm font-semibold">기억</h2>
        {state.memories.length === 0 ? (
          <p className="text-sm text-foreground/60">대화가 진행되면 이 캐릭터가 중요하게 여긴 일이 여기에 기록됩니다.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {state.memories.map((m) => (
              <li key={m.id} className="flex flex-col">
                <span className="text-xs text-foreground/60">
                  {MEMORY_KIND_LABEL[m.kind] ?? m.kind} · {ACQUISITION_LABEL[m.acquisition] ?? m.acquisition} · 중요도 {m.importance}
                  {m.aboutName && ` · ${m.aboutName}에 대해`}
                </span>
                <span className="break-words whitespace-pre-wrap">{m.content}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-foreground/50">AI가 생성한 허구의 캐릭터 기억입니다. 이 캐릭터만 아는 내용이며 다른 캐릭터의 대화에는 쓰이지 않습니다.</p>
      </section>
    </div>
  );
}
