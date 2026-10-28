import { notFound } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { listCharacters } from "@/server/domain/characters/characters";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { LoginRequired } from "../../ui";
import { CharacterList } from "./character-list";

// 캐릭터 탭 (UI 개선, /worlds/[worldId]/characters): 목록·추가. 상세·수정은 /characters/[id], 추가는 /characters/new.

export default async function CharactersPage({ params }: PageProps<"/worlds/[worldId]/characters">) {
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
  return <CharacterList worldId={worldId} characters={characters} />;
}
