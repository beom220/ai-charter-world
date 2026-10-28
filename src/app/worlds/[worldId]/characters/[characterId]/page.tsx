import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BIG_FIVE_LABEL, type BigFiveAxis } from "../../../../../../config/personality-map";
import { getCurrentSession } from "@/server/auth/session";
import { getCharacter } from "@/server/domain/characters/characters";
import { getCharacterInsights } from "@/server/domain/characters/insights";
import { currentWorldEventCursor } from "@/server/events/world-stream";
import { CharacterLiveState, type LiveMemory } from "./live-state";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { LoginRequired } from "../../../ui";
import { ConfirmDeleteButton } from "../../../world-form";
import { CharacterForm } from "../character-form";
import { genderText, tagLabel } from "../character-list";

// 캐릭터 상세 패널과 편집 (PRD §6 /worlds/[worldId]/characters/[characterId]).
// 감정·관계·기억은 여기서만 보여 준다(메인 대화창에는 변화 알림을 띄우지 않는다). 변화 이력 없이 현재 값만 보여 준다(Phase 5-5).
// 장면이 커밋되면 SSE로 알고 최신 값을 다시 읽는다(live-state.tsx, Phase 6).

export default function CharacterPage({ params }: PageProps<"/worlds/[worldId]/characters/[characterId]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-4 sm:p-8">
      <Suspense fallback={<p className="text-sm text-foreground/70">불러오는 중…</p>}>
        <CharacterDetail params={params} />
      </Suspense>
    </main>
  );
}

const panel = "flex flex-col gap-2 rounded-md border border-foreground/15 p-4";


async function CharacterDetail({ params }: { params: Promise<{ worldId: string; characterId: string }> }) {
  const session = await getCurrentSession();
  if (!session) return <LoginRequired />;
  const { worldId, characterId } = await params;

  let c, insights, eventCursor;
  try {
    const userId = asAuthenticatedUserId(session.user.id);
    eventCursor = await currentWorldEventCursor(userId, worldId); // 이후 장면 커밋은 SSE로 받아 다시 읽는다
    [c, insights] = await Promise.all([getCharacter(userId, worldId, characterId), getCharacterInsights(userId, worldId, characterId)]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  return (
    <>
      <Link href={`/worlds/${worldId}`} className="text-sm text-foreground/70 underline">
        ← 세계관으로
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold break-all">{c.name}</h1>
        <p className="text-sm text-foreground/70">
          {genderText(c)} · {c.age ?? "?"}세 · {c.personalityTags.map(tagLabel).join(", ")}
        </p>
      </div>

      <CharacterLiveState
        key={`${c.id}-${eventCursor}`} // 불러오기 후 다시 그리면 커서가 바뀌어 새 값으로 다시 마운트된다
        worldId={worldId}
        characterId={c.id}
        characterName={c.name}
        eventCursor={eventCursor}
        initial={{ emotion: c.emotion, relations: insights.relations, memories: JSON.parse(JSON.stringify(insights.memories)) as LiveMemory[] }}
      >
        <section className={panel}>
          <h2 className="text-sm font-semibold">성격 수치</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
            {(Object.keys(BIG_FIVE_LABEL) as BigFiveAxis[]).map((axis) => (
              <div key={axis} className="contents">
                <dt className="text-foreground/70">{BIG_FIVE_LABEL[axis]}</dt>
                <dd>{c.bigFive[axis]}</dd>
              </div>
            ))}
          </dl>
        </section>
      </CharacterLiveState>

      <section className="flex flex-col gap-3 border-t border-foreground/10 pt-6">
        <h2 className="text-lg font-semibold">설정 수정</h2>
        <CharacterForm
          worldId={worldId}
          characterId={c.id}
          initial={{
            name: c.name,
            gender: c.gender,
            genderCustom: c.genderCustom,
            age: c.age,
            personalityTags: c.personalityTags,
            goal: c.goal,
            characterContext: c.characterContext,
          }}
        />
      </section>

      <section className="flex flex-col gap-2 border-t border-foreground/10 pt-6">
        <ConfirmDeleteButton
          label="캐릭터 삭제"
          title="캐릭터를 삭제할까요?"
          path={`/api/worlds/${worldId}/characters/${c.id}`}
          redirectTo={`/worlds/${worldId}`}
        >
          <strong>{c.name}</strong>은(는) 이후 대화에 참가하지 않습니다. 지난 대화·기억·관계 기록은 남고, 과거 대사에는 &quot;삭제된 캐릭터&quot;로
          표시됩니다.
        </ConfirmDeleteButton>
      </section>
    </>
  );
}
