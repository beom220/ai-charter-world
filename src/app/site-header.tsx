import Link from "next/link";
import { getCurrentSession } from "@/server/auth/session";
import { SignOutButton } from "./login/auth-buttons";

// 공통 상단 바: 세계관 목록·AI 설정 링크와 로그인·로그아웃.
// 스크롤해도 화면 위에 고정한다. 높이는 h-12(48px)로 고정하고 줄바꿈하지 않는다(세계관 탭 바가 그 아래 top-12에 붙는다).

export async function SiteHeader() {
  const session = await getCurrentSession().catch(() => null);
  return (
    <header className="sticky top-0 z-30 h-12 border-b border-foreground/10 bg-header/95 backdrop-blur">
      <nav className="mx-auto flex h-full w-full max-w-3xl items-center gap-4 px-4 text-sm sm:px-8">
        <Link href="/" className="min-w-0 truncate font-semibold">
          AI Character World
        </Link>
        <Link href="/worlds" className="shrink-0">
          세계관
        </Link>
        <Link href="/settings/providers" className="shrink-0">
          AI 설정
        </Link>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {session ? (
            <>
              <span className="hidden text-foreground/70 sm:inline">{session.user.name}</span>
              <SignOutButton />
            </>
          ) : (
            <Link href="/login" className="text-primary-text underline">
              로그인
            </Link>
          )}
        </span>
      </nav>
    </header>
  );
}
