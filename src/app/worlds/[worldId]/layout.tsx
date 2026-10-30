import { Suspense } from "react";
import { getCurrentSession } from "@/server/auth/session";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { getWorld } from "@/server/domain/worlds";
import { WorldTabs } from "./world-tabs";

// 세계관 공통 틀 (UI 개선): 제목 + 상단 탭(대화·캐릭터·세계관 설정·내 세계관). 소유권·404는 각 페이지가 확인한다
// (이 제목 영역은 소유자가 아니면 아무것도 그리지 않는다).
// 탭 바는 스크롤해도 상단 헤더(h-12) 바로 아래에 붙어 있다(sticky). sticky는 부모 상자 안에서만 붙으므로 탭을 페이지 전체를 감싸는
// 바깥 div의 직계 자식으로 두고, 테두리가 헤더처럼 화면 전체 폭이 되도록 본문(<main>, max-w-3xl) 밖에 둔다.

export default function WorldLayout({ children, params }: LayoutProps<"/worlds/[worldId]">) {
  return (
    <div className="flex flex-1 flex-col">
      <Suspense fallback={<div className="h-8" />}>
        <WorldHeader params={params} />
      </Suspense>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 sm:p-8">
        <Suspense fallback={<p className="text-sm text-foreground/70">불러오는 중…</p>}>{children}</Suspense>
      </main>
    </div>
  );
}

async function WorldHeader({ params }: { params: Promise<{ worldId: string }> }) {
  const session = await getCurrentSession();
  if (!session) return null;
  const { worldId } = await params;
  const world = await getWorld(asAuthenticatedUserId(session.user.id), worldId).catch(() => null);
  if (!world) return null;
  return (
    <>
      <div className="mx-auto w-full max-w-3xl px-4 pt-4 pb-4 sm:px-8 sm:pt-8">
        <h1 className="text-2xl font-semibold break-all">{world.name}</h1>
      </div>
      <WorldTabs worldId={world.id} />
    </>
  );
}
