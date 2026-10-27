import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { MAX_ACTIVE_CHARACTERS_PER_WORLD } from "../../../../../../config/limits";
import { getCurrentSession } from "@/server/auth/session";
import { listCharacters } from "@/server/domain/characters/characters";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { LoginRequired } from "../../../ui";
import { CharacterForm } from "../character-form";

// 캐릭터 생성 (PRD §6 /worlds/[worldId]/characters/new).

export default function NewCharacterPage({ params }: PageProps<"/worlds/[worldId]/characters/new">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-4 sm:p-8">
      <Suspense fallback={<p className="text-sm text-foreground/70">불러오는 중…</p>}>
        <NewCharacter params={params} />
      </Suspense>
    </main>
  );
}

async function NewCharacter({ params }: { params: Promise<{ worldId: string }> }) {
  const session = await getCurrentSession();
  if (!session) return <LoginRequired />;
  const { worldId } = await params;

  let count;
  try {
    count = (await listCharacters(asAuthenticatedUserId(session.user.id), worldId)).length;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  return (
    <>
      <Link href={`/worlds/${worldId}`} className="text-sm text-foreground/70 underline">
        ← 세계관으로
      </Link>
      <h1 className="text-2xl font-semibold">새 캐릭터</h1>
      {count >= MAX_ACTIVE_CHARACTERS_PER_WORLD ? (
        <p role="alert" className="text-sm">
          캐릭터는 세계관당 최대 {MAX_ACTIVE_CHARACTERS_PER_WORLD}명입니다. 추가하려면 기존 캐릭터를 삭제하세요.
        </p>
      ) : (
        <CharacterForm worldId={worldId} />
      )}
    </>
  );
}
