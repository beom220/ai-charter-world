import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MAX_ACTIVE_CHARACTERS_PER_WORLD } from "../../../../../../config/limits";
import { getCurrentSession } from "@/server/auth/session";
import { listCharacters } from "@/server/domain/characters/characters";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { LoginRequired } from "../../../ui";
import { CharacterForm } from "../character-form";
import { CharacterList } from "../character-list";

// 캐릭터 생성 (PRD §6 /worlds/[worldId]/characters/new). 만든 뒤에도 이 화면에 머물고, 하단 목록으로 결과를 보인다.

export default function NewCharacterPage({ params }: PageProps<"/worlds/[worldId]/characters/new">) {
  return (
    <div className="flex flex-col gap-6">
      <Suspense fallback={<p className="text-sm text-foreground/70">불러오는 중…</p>}>
        <NewCharacter params={params} />
      </Suspense>
    </div>
  );
}

async function NewCharacter({ params }: { params: Promise<{ worldId: string }> }) {
  const session = await getCurrentSession();
  if (!session) return <LoginRequired />;
  const { worldId } = await params;

  let characters;
  try {
    characters = await listCharacters(asAuthenticatedUserId(session.user.id), worldId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  return (
    <>
      <Link href={`/worlds/${worldId}/characters`} className="text-sm text-foreground/70 underline">
        ← 캐릭터 목록
      </Link>
      <h2 className="text-xl font-semibold">새 캐릭터</h2>
      {characters.length >= MAX_ACTIVE_CHARACTERS_PER_WORLD ? (
        <p role="alert" className="text-sm">
          캐릭터는 세계관당 최대 {MAX_ACTIVE_CHARACTERS_PER_WORLD}명입니다. 추가하려면 기존 캐릭터를 삭제하세요.
        </p>
      ) : (
        <CharacterForm worldId={worldId} />
      )}
      <CharacterList worldId={worldId} characters={characters} showAdd={false} />
    </>
  );
}
