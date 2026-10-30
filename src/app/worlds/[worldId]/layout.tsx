import { Suspense } from "react";
import { getCurrentSession } from "@/server/auth/session";
import { listCharacters } from "@/server/domain/characters/characters";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { getWorld } from "@/server/domain/worlds";
import { ProfileBar } from "./profile-bar";
import { WorldTabs } from "./world-tabs";

// 세계관 공통 틀 (UI 개선): 제목 + 상단 탭(대화·캐릭터·세계관 설정·내 세계관). 소유권·404는 각 페이지가 확인한다
// (이 제목 영역은 소유자가 아니면 아무것도 그리지 않는다).
// 탭 바는 스크롤해도 상단 헤더(h-12) 바로 아래에 붙어 있다(sticky). sticky는 부모 상자 안에서만 붙으므로 탭을 페이지 전체를 감싸는
// 바깥 div의 직계 자식으로 두고, 테두리가 헤더처럼 화면 전체 폭이 되도록 본문(<main>, max-w-3xl) 밖에 둔다.
// 탭 바 바로 아래의 캐릭터 프로필(profile-bar.tsx, 현재 감정 표정)도 같은 sticky 묶음 안에 둔다: 하나의 상자로 함께 붙으므로
// 두 영역 사이에 틈·겹침이 없고, 묶음 높이만큼 문서 흐름을 차지해 본문이 가려지지 않는다(헤더 z-30 아래 z-20).

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
  const userId = asAuthenticatedUserId(session.user.id);
  const world = await getWorld(userId, worldId).catch(() => null);
  if (!world) return null;
  const characters = await listCharacters(userId, world.id);
  return (
    <>
      <div className="mx-auto w-full max-w-3xl px-4 pt-4 pb-4 sm:px-8 sm:pt-8">
        <h1 className="text-2xl font-semibold break-all">{world.name}</h1>
      </div>
      <div className="sticky top-12 z-20 bg-background/95 backdrop-blur">
        <WorldTabs worldId={world.id} />
        <ProfileBar worldId={world.id} initial={characters.map((c) => ({ id: c.id, name: c.name, avatarId: c.avatarId, mood: c.emotion?.mood ?? null }))} />
      </div>
    </>
  );
}
