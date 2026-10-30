import Link from "next/link";
import { Suspense } from "react";
import { LoadingFallback } from "@/app/loading-fallback";
import { getCurrentSession } from "@/server/auth/session";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { listWorlds } from "@/server/domain/worlds";
import { LoginRequired, primaryButton } from "./ui";

// 세계관 목록 (PRD §6 /worlds). 본인 소유 세계관만 보인다.

export default function WorldsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-4 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">내 세계관</h1>
        <Link href="/worlds/new" className={primaryButton}>
          새 세계관
        </Link>
      </div>
      <Suspense fallback={<LoadingFallback />}>
        <WorldList />
      </Suspense>
    </main>
  );
}

async function WorldList() {
  const session = await getCurrentSession();
  if (!session) return <LoginRequired />;
  const worlds = await listWorlds(asAuthenticatedUserId(session.user.id));
  if (worlds.length === 0) return <p className="text-sm text-foreground/70">아직 세계관이 없습니다. 새 세계관을 만들어 보세요.</p>;

  return (
    <ul className="flex flex-col divide-y divide-foreground/10 rounded-md border border-foreground/15">
      {worlds.map((w) => (
        <li key={w.id}>
          <Link href={`/worlds/${w.id}`} className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-hover">
            <span className="font-medium break-all">{w.name}</span>
            <span className="text-xs text-foreground/60">
              수정 {w.updatedAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
