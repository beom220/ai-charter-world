import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BIG_FIVE_LABEL, type BigFiveAxis } from "../../../../../../config/personality-map";
import { getCurrentSession } from "@/server/auth/session";
import { getCharacter } from "@/server/domain/characters/characters";
import { getCharacterInsights, type RelationValues } from "@/server/domain/characters/insights";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { LoginRequired, MOOD_LABEL } from "../../../ui";
import { ConfirmDeleteButton } from "../../../world-form";
import { CharacterForm } from "../character-form";
import { genderText, tagLabel } from "../character-list";

// 캐릭터 상세 패널과 편집 (PRD §6 /worlds/[worldId]/characters/[characterId]).
// 감정·관계·기억은 여기서만 보여 준다(메인 대화창에는 변화 알림을 띄우지 않는다). 변화 이력 없이 현재 값만 보여 준다(Phase 5-5).

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

const MEMORY_KIND_LABEL: Record<string, string> = {
  EVENT: "사건",
  PROMISE: "약속",
  CONFESSION: "고백",
  CONFLICT: "갈등",
  SECRET: "비밀",
  IMPRESSION: "인상",
  OTHER: "기타",
};
const ACQUISITION_LABEL: Record<string, string> = { WITNESSED: "직접 겪음", TOLD: "전해 들음", OBSERVED: "관찰" };

const relationText = (r: RelationValues) => `호감 ${r.affinity} · 신뢰 ${r.trust} · 존중 ${r.respect} · 친밀 ${r.familiarity}`;

async function CharacterDetail({ params }: { params: Promise<{ worldId: string; characterId: string }> }) {
  const session = await getCurrentSession();
  if (!session) return <LoginRequired />;
  const { worldId, characterId } = await params;

  let c, insights;
  try {
    const userId = asAuthenticatedUserId(session.user.id);
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

      <div className="grid gap-3 sm:grid-cols-2">
        <section className={panel}>
          <h2 className="text-sm font-semibold">현재 감정</h2>
          <p className="text-sm">
            {c.emotion ? `${MOOD_LABEL[c.emotion.mood]} (강도 ${c.emotion.intensity}/100)` : "기록 없음"}
          </p>
        </section>
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
        <section className={`${panel} sm:col-span-2`}>
          <h2 className="text-sm font-semibold">관계</h2>
          {insights.relations.length === 0 ? (
            <p className="text-sm text-foreground/60">다른 캐릭터가 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {insights.relations.map((r) => (
                <li key={r.otherId} className="flex flex-col">
                  <Link href={`/worlds/${worldId}/characters/${r.otherId}`} className="font-medium underline">
                    {r.otherName}
                  </Link>
                  <span className="text-foreground/80">
                    {c.name} → {r.otherName}: {relationText(r.outgoing)}
                  </span>
                  <span className="text-foreground/60">
                    {r.otherName} → {c.name}: {relationText(r.incoming)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-foreground/50">호감·신뢰·존중 -100~100, 친밀 0~100. 대화 장면마다 축별 최대 ±5씩 변합니다.</p>
        </section>
        <section className={`${panel} sm:col-span-2`}>
          <h2 className="text-sm font-semibold">기억</h2>
          {insights.memories.length === 0 ? (
            <p className="text-sm text-foreground/60">대화가 진행되면 이 캐릭터가 중요하게 여긴 일이 여기에 기록됩니다.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {insights.memories.map((m) => (
                <li key={m.id} className="flex flex-col">
                  <span className="text-xs text-foreground/60">
                    {MEMORY_KIND_LABEL[m.kind] ?? m.kind} · {ACQUISITION_LABEL[m.acquisition] ?? m.acquisition} · 중요도 {m.importance}
                    {m.aboutName && ` · ${m.aboutName}에 대해`}
                  </span>
                  <span className="break-words whitespace-pre-wrap">{m.content}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-foreground/50">AI가 생성한 허구의 캐릭터 기억입니다. 이 캐릭터만 아는 내용이며 다른 캐릭터의 대화에는 쓰이지 않습니다.</p>
        </section>
      </div>

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
