import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BACKGROUND_RARITY_LABEL, BACKGROUND_STAGE_LABEL, findBackground, requiresAdulthood, type BackgroundStage } from "../../../../../../config/character-backgrounds";
import { BIG_FIVE_LABEL, type BigFiveAxis } from "../../../../../../config/personality-map";
import { getCurrentSession } from "@/server/auth/session";
import { findDeletedCharacterName, getCharacter, listCharacters } from "@/server/domain/characters/characters";
import { getCharacterInsights } from "@/server/domain/characters/insights";
import { currentWorldEventCursor } from "@/server/events/world-stream";
import { CharacterLiveState, type LiveMemory } from "./live-state";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { LoginRequired } from "../../../ui";
import { ConfirmDeleteButton } from "../../../world-form";
import { CharacterForm } from "../character-form";
import { CharacterList, genderText, tagLabel } from "../character-list";

// 캐릭터 상세 패널과 편집 (PRD §6 /worlds/[worldId]/characters/[characterId]).
// 감정·관계·기억은 여기서만 보여 준다(메인 대화창에는 변화 알림을 띄우지 않는다). 변화 이력 없이 현재 값만 보여 준다(Phase 5-5).
// 장면이 커밋되면 SSE로 알고 최신 값을 다시 읽는다(live-state.tsx, Phase 6).
// 맨 아래에 같은 세계관의 캐릭터 목록을 보여 다른 캐릭터로 바로 옮겨 갈 수 있게 한다(현재 캐릭터 강조).

export default function CharacterPage({ params }: PageProps<"/worlds/[worldId]/characters/[characterId]">) {
  return (
    <div className="flex flex-col gap-6">
      <Suspense fallback={<p className="text-sm text-foreground/70">불러오는 중…</p>}>
        <CharacterDetail params={params} />
      </Suspense>
    </div>
  );
}

const panel = "flex flex-col gap-2 rounded-md border border-foreground/15 p-4";


async function CharacterDetail({ params }: { params: Promise<{ worldId: string; characterId: string }> }) {
  const session = await getCurrentSession();
  if (!session) return <LoginRequired />;
  const { worldId, characterId } = await params;

  let c, insights, eventCursor, characters;
  try {
    const userId = asAuthenticatedUserId(session.user.id);
    eventCursor = await currentWorldEventCursor(userId, worldId); // 이후 장면 커밋은 SSE로 받아 다시 읽는다
    [c, insights, characters] = await Promise.all([getCharacter(userId, worldId, characterId), getCharacterInsights(userId, worldId, characterId), listCharacters(userId, worldId)]);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    // 대화 속 이름에서 들어왔는데 삭제된 캐릭터면 안내한다. 없거나 타인 소유면 404
    const deletedName = await findDeletedCharacterName(asAuthenticatedUserId(session.user.id), worldId, characterId);
    if (deletedName === null) notFound();
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="rounded-md bg-foreground/5 px-3 py-2 text-sm">
          <strong>{deletedName}</strong>은(는) 삭제된 캐릭터입니다. 지난 대화의 발언은 남아 있지만 상세 정보는 볼 수 없습니다.
        </p>
        <div className="flex gap-3 text-sm">
          <Link href={`/worlds/${worldId}`} className="text-primary-text underline">
            ← 대화로
          </Link>
          <Link href={`/worlds/${worldId}/characters`} className="text-primary-text underline">
            캐릭터 목록
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold break-all">{c.name}</h2>
        <p className="text-sm text-foreground/70">
          {genderText(c)} · {c.age ?? "?"}세 · {c.personalityTags.map(tagLabel).join(", ")}
        </p>
      </div>

      <section className={panel}>
        <h2 className="text-sm font-semibold">배경 (과거 경험)</h2>
        <dl className="flex flex-col gap-1.5 text-sm">
          {(
            [
              ["CHILDHOOD", c.childhoodBackgroundId],
              ["ADULTHOOD", c.adulthoodBackgroundId],
            ] as [BackgroundStage, string | null][]
          ).map(([stage, id]) => {
            const preset = findBackground(id, stage);
            return (
              <div key={stage} className="flex flex-col sm:flex-row sm:gap-3">
                <dt className="w-14 shrink-0 text-foreground/70">{BACKGROUND_STAGE_LABEL[stage]}</dt>
                <dd>
                  {preset ? (
                    <>
                      <span className="font-medium">{preset.name}</span>
                      <span className="text-xs text-foreground/60"> · {BACKGROUND_RARITY_LABEL[preset.rarity]}</span>
                      <span className="block text-xs text-foreground/70">{preset.description}</span>
                    </>
                  ) : (
                    <span className="text-foreground/60">{stage === "ADULTHOOD" && c.age !== null && !requiresAdulthood(c.age) ? "해당 없음 (18세 이하)" : "설정되지 않음 — 아래 설정 수정에서 선택하세요"}</span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      <CharacterLiveState
        key={`${c.id}-${eventCursor}`} // 불러오기 후 다시 그리면 커서가 바뀌어 새 값으로 다시 마운트된다
        worldId={worldId}
        characterId={c.id}
        characterName={c.name}
        eventCursor={eventCursor}
        initial={{
          emotion: c.emotion,
          condition: c.condition,
          relations: insights.relations,
          memories: JSON.parse(JSON.stringify(insights.memories)) as LiveMemory[],
        }}
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

      {c.condition.vital === "DEAD" ? (
        <p role="status" className="rounded-md border border-red-600/40 bg-red-600/5 px-3 py-2 text-sm">
          사망한 캐릭터는 설정을 수정하거나 대화에 참가시킬 수 없습니다. 캐릭터 슬롯은 계속 차지하며, 지난 대화·기억·관계 기록은 남습니다.
        </p>
      ) : (
      <section className="flex flex-col gap-3 border-t border-foreground/10 pt-6">
        <h2 className="text-lg font-semibold">설정 수정</h2>
        <CharacterForm
          worldId={worldId}
          characterId={c.id}
          initial={{
            name: c.name,
            gender: c.gender,
            age: c.age,
            personalityTags: c.personalityTags,
            goal: c.goal,
            characterContext: c.characterContext,
            childhoodBackgroundId: c.childhoodBackgroundId,
            adulthoodBackgroundId: c.adulthoodBackgroundId,
          }}
        />
      </section>
      )}

      <section className="flex flex-col gap-2 border-t border-foreground/10 pt-6">
        <ConfirmDeleteButton
          label="캐릭터 삭제"
          title="캐릭터를 삭제할까요?"
          path={`/api/worlds/${worldId}/characters/${c.id}`}
          redirectTo={`/worlds/${worldId}`}
          lockWorldId={worldId}
        >
          <strong>{c.name}</strong>은(는) 이후 대화에 참가하지 않습니다. 지난 대화·기억·관계 기록은 남고, 과거 대사에는 &quot;삭제된 캐릭터&quot;로
          표시됩니다.
        </ConfirmDeleteButton>
      </section>

      <div className="border-t border-foreground/10 pt-6">
        <CharacterList worldId={worldId} characters={characters} currentId={c.id} />
      </div>
    </>
  );
}
