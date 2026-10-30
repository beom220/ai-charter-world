import { Suspense } from "react";
import { LoadingFallback } from "@/app/loading-fallback";
import { getCurrentSession } from "@/server/auth/session";
import { LoginRequired } from "../ui";
import { WorldForm } from "../world-form";

// 세계관 생성 (PRD §6 /worlds/new). 최소 UI: 이름 + 자유 형식 세계관 컨텍스트.

export default function NewWorldPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-4 sm:p-8">
      <h1 className="text-2xl font-semibold">새 세계관</h1>
      <Suspense fallback={<LoadingFallback />}>
        <NewWorld />
      </Suspense>
    </main>
  );
}

async function NewWorld() {
  const session = await getCurrentSession();
  if (!session) return <LoginRequired />;
  return <WorldForm initial={null} />;
}
