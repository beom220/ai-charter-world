"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 세계관 상단 탭 (UI 개선): 대화(/worlds/[id]) · 캐릭터(/worlds/[id]/characters…) · 세계관 설정(/worlds/[id]/settings).
// 각 탭은 별도 URL이다. 대화 탭을 떠나면 대화 패널이 숨겨지며 서버에 이탈을 알린다(scene-panel.tsx).
// 긴 대화를 읽다가도 이동할 수 있게 스크롤 시 상단 헤더 아래에 고정하고(테두리는 화면 전체 폭), 오른쪽에 내 세계관(목록) 링크를 둔다.
// 고정(sticky)·배경은 layout.tsx의 묶음이 맡는다(바로 아래 캐릭터 프로필과 함께 붙어 틈·겹침이 없게).

export function WorldTabs({ worldId }: { worldId: string }) {
  const pathname = usePathname();
  const base = `/worlds/${worldId}`;
  const tabs = [
    { href: base, label: "대화", active: pathname === base },
    { href: `${base}/characters`, label: "캐릭터", active: pathname.startsWith(`${base}/characters`) },
    { href: `${base}/settings`, label: "세계관 설정", active: pathname.startsWith(`${base}/settings`) },
  ];
  return (
    <nav aria-label="세계관 메뉴" className="border-b border-foreground/10">
      <div className="mx-auto flex w-full max-w-3xl gap-1 px-4 sm:px-8">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={t.active ? "page" : undefined}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm sm:px-4 ${t.active ? "border-primary font-semibold text-primary-text" : "border-transparent text-foreground/60 hover:text-foreground"}`}
          >
            {t.label}
          </Link>
        ))}
        <Link href="/worlds" className="ml-auto shrink-0 self-center py-2 pl-2 text-sm text-foreground/60 hover:text-foreground">
          ← 내 세계관
        </Link>
      </div>
    </nav>
  );
}
