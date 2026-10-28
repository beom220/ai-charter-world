import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getCurrentSession } from "@/server/auth/session";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { getWorld } from "@/server/domain/worlds";
import { listCharacters } from "@/server/domain/characters/characters";
import { CharacterList } from "./characters/character-list";
import { ScenePanel, type SceneItem } from "./scene-panel";
import { listScenes } from "@/server/domain/scenes/generate-scene";
import { LoginRequired, STATUS_LABEL } from "../ui";
import { DeleteWorldButton, WorldForm } from "../world-form";

// 세계관 상세·수정 (PRD §6 /worlds/[worldId]). 없거나 타인 소유이면 404.

export default function WorldPage({ params }: PageProps<"/worlds/[worldId]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-4 sm:p-8">
      <Link href="/worlds" className="text-sm text-foreground/70 underline">
        ← 내 세계관
      </Link>
      <Suspense fallback={<p className="text-sm text-foreground/70">불러오는 중…</p>}>
        <WorldDetail params={params} />
      </Suspense>
    </main>
  );
}

async function WorldDetail({ params }: { params: Promise<{ worldId: string }> }) {
  const session = await getCurrentSession();
  if (!session) return <LoginRequired />;
  const { worldId } = await params;

  const userId = asAuthenticatedUserId(session.user.id);
  let world, characters, scenes;
  try {
    [world, characters, scenes] = await Promise.all([getWorld(userId, worldId), listCharacters(userId, worldId), listScenes(userId, worldId)]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold break-all">{world.name}</h1>
        <p className="text-xs text-foreground/60">
          {STATUS_LABEL[world.runtimeStatus]} · 만든 날 {world.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
        </p>
      </div>
      <CharacterList worldId={world.id} characters={characters} />
      <ScenePanel
        worldId={world.id}
        activeCount={characters.length}
        initialScenes={JSON.parse(JSON.stringify(scenes.scenes)) as SceneItem[]}
        initialHasMore={scenes.hasMore}
      />
      <section className="flex flex-col gap-3 border-t border-foreground/10 pt-6">
        <h2 className="text-lg font-semibold">세계관 설정</h2>
        <WorldForm initial={{ id: world.id, name: world.name, worldContext: world.worldContext }} />
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
