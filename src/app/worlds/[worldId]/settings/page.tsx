import { Suspense } from "react";
import { LoadingFallback } from "@/app/loading-fallback";
import { notFound } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { getWorld } from "@/server/domain/worlds";
import { LoginRequired, STATUS_LABEL } from "../../ui";
import { DeleteWorldButton, WorldForm } from "../../world-form";

// 세계관 설정 탭 (UI 개선, /worlds/[worldId]/settings): 이름·설명 조회·수정, 삭제. 없거나 타인 소유이면 404.

// cacheComponents: 세션·params·DB를 읽는 부분은 페이지 안의 Suspense 경계에 둔다 (탐색·프리렌더 시 uncached data 오류 방지)
export default function WorldSettingsPage({ params }: PageProps<"/worlds/[worldId]/settings">) {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <WorldSettings params={params} />
    </Suspense>
  );
}

async function WorldSettings({ params }: { params: PageProps<"/worlds/[worldId]/settings">["params"] }) {
  const session = await getCurrentSession();
  if (!session) return <LoginRequired />;
  const { worldId } = await params;
  let world;
  try {
    world = await getWorld(asAuthenticatedUserId(session.user.id), worldId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  return (
    <>
      <p className="text-xs text-foreground/60">
        {STATUS_LABEL[world.runtimeStatus]} · 만든 날 {world.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
      </p>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">세계관 설정</h2>
        <WorldForm initial={{ id: world.id, name: world.name, worldContext: world.worldContext }} locked={world.settingsLocked} />
      </section>
      <section className="flex flex-col gap-2 border-t border-foreground/10 pt-6">
        <h2 className="text-sm font-semibold">위험 구역</h2>
        <div>
          <DeleteWorldButton worldId={world.id} worldName={world.name} />
        </div>
      </section>
    </>
  );
}
