"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { MOOD_LABEL } from "../../../ui";
import { send } from "../../../world-form";

// 캐릭터 상세의 감정·관계·기억 (Phase 5-5 화면, Phase 6 실시간 갱신).
// - 세계관 SSE를 구독해 scene.committed가 오면 /characters/[id]/state를 다시 읽는다. 상태 변화 수치는 메인 피드에 보이지 않는다.
// - 요청마다 번호를 붙여 가장 최근 요청의 응답만 반영한다(응답 순서가 뒤집혀도 오래된 값으로 덮어쓰지 않음).
// - state.replaced(불러오기)면 페이지 전체를 서버에서 다시 그린다(프로필이 바뀌었거나 캐릭터가 없어졌을 수 있음).

type RelationValues = { affinity: number; trust: number; respect: number; familiarity: number };
export type LiveMemory = { id: string; kind: string; acquisition: string; importance: number; content: string; aboutName: string | null };
type LiveState = {
  emotion: { mood: string; intensity: number } | null;
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
const relationText = (r: RelationValues) => `호감 ${r.affinity} · 신뢰 ${r.trust} · 존중 ${r.respect} · 친밀 ${r.familiarity}`;

export function CharacterLiveState({
  worldId,
  characterId,
  characterName,
  eventCursor,
  initial,
  children,
}: {
  worldId: string;
  characterId: string;
  characterName: string;
  eventCursor: string;
  initial: LiveState;
  /** 감정 옆에 놓을 서버 렌더 패널 (성격 수치) */
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const latest = useRef(0);

  /** 최신 값 다시 읽기. 늦게 도착한 이전 요청의 응답은 버린다 */
  const reload = useCallback(async () => {
    const seq = ++latest.current;
    const { ok, json } = await send(`/api/worlds/${worldId}/characters/${characterId}/state`, "GET").catch(() => ({ ok: false, json: null }));
    if (ok && seq === latest.current) setState(json as LiveState);
  }, [worldId, characterId]);

  useEffect(() => {
    // 보기 전용 구독(watch=1): 상세 화면을 보고 있다고 시뮬레이션이 계속 돌지 않게 대화 화면 연결로 세지 않는다
    const es = new EventSource(`/api/worlds/${worldId}/simulation/stream?watch=1&lastEventId=${encodeURIComponent(eventCursor)}`);
    es.addEventListener("scene.committed", () => void reload());
    es.addEventListener("sync.required", () => void reload());
    es.addEventListener("state.replaced", () => router.refresh());
    return () => es.close();
  }, [worldId, eventCursor, reload, router]);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <section className={panel}>
        <h2 className="text-sm font-semibold">현재 감정</h2>
        <p className="text-sm">{state.emotion ? `${MOOD_LABEL[state.emotion.mood]} (강도 ${state.emotion.intensity}/100)` : "기록 없음"}</p>
      </section>
      {children}
      <section className={`${panel} sm:col-span-2`}>
        <h2 className="text-sm font-semibold">관계</h2>
        {state.relations.length === 0 ? (
          <p className="text-sm text-foreground/60">다른 캐릭터가 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {state.relations.map((r) => (
              <li key={r.otherId} className="flex flex-col">
                <Link href={`/worlds/${worldId}/characters/${r.otherId}`} className="font-medium underline">
                  {r.otherName}
                </Link>
                <span className="text-foreground/80">
                  {characterName} → {r.otherName}: {relationText(r.outgoing)}
                </span>
                <span className="text-foreground/60">
                  {r.otherName} → {characterName}: {relationText(r.incoming)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-foreground/50">호감·신뢰·존중 -100~100, 친밀 0~100. 대화 장면마다 축별 최대 ±5씩 변합니다.</p>
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
