"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { moodExpression } from "@/lib/avatars";
import { Avatar } from "../avatar";
import { send } from "../world-form";
import { CHARACTERS_EVENT } from "./world-events";

// 상단 고정 캐릭터 프로필 (탭 바 바로 아래, layout.tsx의 같은 sticky 묶음 안). 활성 캐릭터마다 현재 감정 표정과 이름을 보이고 상세로 잇는다.
// - 표정이 바뀌는 곳은 여기와 캐릭터 상세뿐이다(대화창·생성/편집은 neutral). 출처는 서버의 현재 감정(GET /characters).
// - 새 SSE 구독·폴링을 만들지 않는다. 대화 패널·상세 화면이 이미 받는 SSE(장면 커밋·불러오기·재동기화·재연결)를 CHARACTERS_EVENT로 넘겨받고,
//   경로가 바뀔 때(생성·수정·삭제 후 이동 포함) 다시 읽는다. 가장 최근 요청의 응답만 반영한다.
// - 이 컴포넌트의 상태만 바뀌므로 대화 피드는 다시 그려지지 않는다. 캐릭터가 없으면 아무것도 그리지 않는다.

export type ProfileBarCharacter = { id: string; name: string; avatarId: string | null; mood: string | null };

type ApiCharacter = { id: string; name: string; avatarId: string | null; emotion: { mood: string } | null };

export function ProfileBar({ worldId, initial }: { worldId: string; initial: ProfileBarCharacter[] }) {
  const pathname = usePathname();
  const [characters, setCharacters] = useState(initial);
  const [propInitial, setPropInitial] = useState(initial);
  if (propInitial !== initial) {
    // 서버가 다시 그리면(router.refresh) 새 값으로
    setPropInitial(initial);
    setCharacters(initial);
  }
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++latest.current;
    const { ok, json } = await send(`/api/worlds/${worldId}/characters`, "GET").catch(() => ({ ok: false, json: null }));
    if (!ok || seq !== latest.current) return;
    setCharacters((json.characters as ApiCharacter[]).map((c) => ({ id: c.id, name: c.name, avatarId: c.avatarId, mood: c.emotion?.mood ?? null })));
  }, [worldId]);

  useEffect(() => {
    const onChange = () => void reload();
    window.addEventListener(CHARACTERS_EVENT, onChange);
    return () => window.removeEventListener(CHARACTERS_EVENT, onChange);
  }, [reload]);

  // 첫 렌더는 서버 값을 쓰고, 그 뒤 경로가 바뀔 때마다 다시 읽는다
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (firstPath.current === pathname) return;
    firstPath.current = pathname;
    void reload();
  }, [pathname, reload]);

  if (characters.length === 0) return null;
  return (
    <nav aria-label="캐릭터 프로필" className="border-b border-foreground/10">
      <ul className="mx-auto flex w-full max-w-3xl gap-1 overflow-x-auto px-4 py-1.5 sm:px-8">
        {characters.map((c) => {
          const href = `/worlds/${worldId}/characters/${c.id}`;
          const current = pathname === href;
          return (
            <li key={c.id} className="shrink-0">
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={`flex w-16 flex-col items-center gap-0.5 rounded-md px-1 py-1 outline-offset-2 hover:bg-hover ${current ? "bg-primary/10" : ""}`}
              >
                <Avatar
                  avatarId={c.avatarId}
                  expression={moodExpression(c.mood)}
                  name={c.name}
                  size={40}
                  eager
                  className={`border ${current ? "border-primary" : "border-primary-soft/60"}`}
                />
                <span className={`w-full truncate text-center text-[11px] leading-tight ${current ? "font-semibold text-primary-text" : "text-foreground/80"}`}>{c.name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
