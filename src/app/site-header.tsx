import Link from "next/link";
import { getCurrentSession } from "@/server/auth/session";
import { SignOutButton } from "./login/auth-buttons";

// 공통 상단 바: 세계관 목록·AI 설정 링크와 로그인·로그아웃.

export async function SiteHeader() {
  const session = await getCurrentSession().catch(() => null);
  return (
    <header className="border-b border-foreground/10">
      <nav className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm sm:px-8">
        <Link href="/" className="font-semibold">
          AI Character World
        </Link>
        <Link href="/worlds">세계관</Link>
        <Link href="/settings/providers">AI 설정</Link>
        <span className="ml-auto flex items-center gap-3">
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
