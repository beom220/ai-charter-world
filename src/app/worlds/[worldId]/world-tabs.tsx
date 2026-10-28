"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 세계관 상단 탭 (UI 개선): 대화(/worlds/[id]) · 캐릭터(/worlds/[id]/characters…) · 세계관 설정(/worlds/[id]/settings).
// 각 탭은 별도 URL이다. 대화 탭을 떠나면 대화 패널이 숨겨지며 서버에 이탈을 알린다(scene-panel.tsx).

export function WorldTabs({ worldId }: { worldId: string }) {
  const pathname = usePathname();
  const base = `/worlds/${worldId}`;
  const tabs = [
    { href: base, label: "대화", active: pathname === base },
    { href: `${base}/characters`, label: "캐릭터", active: pathname.startsWith(`${base}/characters`) },
    { href: `${base}/settings`, label: "세계관 설정", active: pathname.startsWith(`${base}/settings`) },
  ];
  return (
    <nav aria-label="세계관 메뉴" className="flex gap-1 border-b border-foreground/10">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={`-mb-px border-b-2 px-4 py-2 text-sm ${t.active ? "border-foreground font-semibold" : "border-transparent text-foreground/60 hover:text-foreground"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
