import { MAX_ACTIVE_CHARACTERS_PER_WORLD } from "../../../../config/limits";
import { bigFiveFromTags, type BigFive } from "../../../../config/personality-map";
import { adulthoodBackgroundIssue, type CharacterInput, type GenderValue } from "@/lib/schemas/character";
import { prisma } from "@/server/db/client";
import { BadRequestError, ConflictError, NotFoundError } from "@/server/domain/errors";
import type { AuthenticatedUserId } from "@/server/domain/identity";
import { lockOwnedWorld } from "@/server/domain/worlds";
import { randomAge } from "./random";

// 캐릭터 CRUD (PRD FR-04, database.md §6.6·§6.7·§7). 런타임 독립 모듈.
// - 모든 접근은 world.ownerId 조건을 건다. 없거나 타인 소유이거나 삭제된 캐릭터는 NotFoundError(404).
// - 변경은 World 행 잠금 → GameState changeSeq += 1 순서로 한 트랜잭션에서 한다.
// - 삭제는 소프트 삭제(deletedAt). 메시지·관계·기억·감정 행은 그대로 둔다.
// - 배경(Phase 7-1): 유년기는 필수, 성년기는 확정 나이 19세 이상이면 필수·18세 이하면 불가. 나이를 비운 입력은
//   나이를 정한 뒤(생성: 성인 자동, 수정: 현재 나이 유지) 다시 검사해 400으로 거절한다. 기존 NULL 캐릭터는 그대로 조회된다.

export type CharacterView = {
  id: string;
  name: string;
  gender: GenderValue;
  genderCustom: string | null;
  age: number | null;
  personalityTags: string[];
  bigFive: BigFive;
  goal: string;
  characterContext: string;
  /** 배경 프리셋 ID (구버전 데이터는 NULL일 수 있다) */
  childhoodBackgroundId: string | null;
  adulthoodBackgroundId: string | null;
  emotion: { mood: string; intensity: number } | null;
  createdAt: Date;
  updatedAt: Date;
};

const viewSelect = {
  id: true,
  name: true,
  gender: true,
  genderCustom: true,
  age: true,
  personalityTags: true,
  extraversion: true,
  agreeableness: true,
  conscientiousness: true,
  emotionalStability: true,
  openness: true,
  goal: true,
  characterContext: true,
  childhoodBackgroundId: true,
  adulthoodBackgroundId: true,
  createdAt: true,
  updatedAt: true,
  emotionState: { select: { mood: true, intensity: true } },
} as const;

type Row = {
  id: string;
  name: string;
  gender: GenderValue;
  genderCustom: string | null;
  age: number | null;
  personalityTags: string[];
  extraversion: number;
  agreeableness: number;
  conscientiousness: number;
  emotionalStability: number;
  openness: number;
  goal: string | null;
  characterContext: string;
  childhoodBackgroundId: string | null;
  adulthoodBackgroundId: string | null;
  createdAt: Date;
  updatedAt: Date;
  emotionState: { mood: string; intensity: number } | null;
};

function toView(r: Row): CharacterView {
  const { extraversion, agreeableness, conscientiousness, emotionalStability, openness, emotionState, goal, ...rest } = r;
  return {
    ...rest,
    goal: goal ?? "",
    bigFive: { extraversion, agreeableness, conscientiousness, emotionalStability, openness },
    emotion: emotionState,
  };
}

const activeWhere = (userId: AuthenticatedUserId, worldId: string) => ({ worldId, deletedAt: null, world: { ownerId: userId } });

/** 입력 → 저장 값. 나이 비움은 저장 시 자동으로 정한다 (architecture.md §13). 성별은 남자·여자만 받는다. Big Five는 태그에서 계산한다 */
function toData(input: CharacterInput) {
  const gender = input.gender;
  const age = input.age ?? randomAge();
  const issue = adulthoodBackgroundIssue(age, input.adulthoodBackgroundId);
  if (issue) throw new BadRequestError(issue);
  return {
    name: input.name,
    gender,
    genderCustom: null,
    age,
    personalityTags: input.personalityTags,
    ...bigFiveFromTags(input.personalityTags),
    goal: input.goal === "" ? null : input.goal,
    characterContext: input.characterContext,
    childhoodBackgroundId: input.childhoodBackgroundId,
    adulthoodBackgroundId: input.adulthoodBackgroundId,
  };
}

const bumpChangeSeq = (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], worldId: string) =>
  tx.$executeRaw`UPDATE "GameState" SET "changeSeq" = "changeSeq" + 1, "updatedAt" = now() WHERE "worldId" = ${worldId}`;

/** 세계관의 활성 캐릭터 목록. 세계관이 없거나 타인 소유면 404 */
export async function listCharacters(userId: AuthenticatedUserId, worldId: string): Promise<CharacterView[]> {
  const world = await prisma.world.findFirst({ where: { id: worldId, ownerId: userId }, select: { id: true } });
  if (!world) throw new NotFoundError();
  const rows = await prisma.character.findMany({
    where: activeWhere(userId, worldId),
    select: viewSelect,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toView);
}

export async function getCharacter(userId: AuthenticatedUserId, worldId: string, characterId: string): Promise<CharacterView> {
  const row = await prisma.character.findFirst({ where: { id: characterId, ...activeWhere(userId, worldId) }, select: viewSelect });
  if (!row) throw new NotFoundError();
  return toView(row);
}

/** 삭제된(소프트 삭제) 캐릭터의 이름. 소유자 세계관의 삭제된 캐릭터가 아니면 null (안내용) */
export async function findDeletedCharacterName(userId: AuthenticatedUserId, worldId: string, characterId: string): Promise<string | null> {
  const row = await prisma.character.findFirst({
    where: { id: characterId, worldId, deletedAt: { not: null }, world: { ownerId: userId } },
    select: { name: true },
  });
  return row?.name ?? null;
}

/** 캐릭터 생성 (database.md §6.6). World 행 잠금으로 동시 생성을 직렬화해 활성 6명 상한을 지킨다 */
export async function createCharacter(userId: AuthenticatedUserId, worldId: string, input: CharacterInput): Promise<CharacterView> {
  const id = await prisma.$transaction(async (tx) => {
    await lockOwnedWorld(tx, userId, worldId);
    const active = await tx.character.count({ where: { worldId, deletedAt: null } });
    if (active >= MAX_ACTIVE_CHARACTERS_PER_WORLD) {
      throw new ConflictError("CHARACTER_LIMIT", `세계관당 캐릭터는 최대 ${MAX_ACTIVE_CHARACTERS_PER_WORLD}명까지 만들 수 있습니다.`);
    }
    await bumpChangeSeq(tx, worldId);
    const sortOrder = await tx.character.count({ where: { worldId } });
    const character = await tx.character.create({ data: { worldId, sortOrder, ...toData(input) } });
    await tx.emotionState.create({
      data: { characterId: character.id, worldId, mood: character.initialMood, intensity: character.initialMoodIntensity },
    });
    return character.id;
  });
  return getCharacter(userId, worldId, id);
}

/**
 * 캐릭터 수정 (database.md §6.7). 실제로 값이 바뀐 경우에만 changeSeq += 1.
 * 감정·관계·기억·메시지는 건드리지 않는다. 다음 장면부터 새 설정이 반영된다(PRD FR-04).
 */
export async function updateCharacter(
  userId: AuthenticatedUserId,
  worldId: string,
  characterId: string,
  input: CharacterInput,
): Promise<{ character: CharacterView; changed: boolean }> {
  const changed = await prisma.$transaction(async (tx) => {
    await lockOwnedWorld(tx, userId, worldId);
    const current = await tx.character.findFirst({ where: { id: characterId, worldId, deletedAt: null } });
    if (!current) throw new NotFoundError();

    // 나이 비움은 기존 값을 유지한다
    const data = toData({ ...input, age: input.age ?? current.age });
    const same =
      current.name === data.name &&
      current.gender === data.gender &&
      current.genderCustom === data.genderCustom &&
      current.age === data.age &&
      current.personalityTags.join(",") === data.personalityTags.join(",") &&
      (current.goal ?? null) === data.goal &&
      current.characterContext === data.characterContext &&
      current.childhoodBackgroundId === data.childhoodBackgroundId &&
      current.adulthoodBackgroundId === data.adulthoodBackgroundId;
    if (same) return false;

    await tx.character.update({ where: { id: characterId }, data });
    await bumpChangeSeq(tx, worldId);
    return true;
  });
  return { character: await getCharacter(userId, worldId, characterId), changed };
}

/** 소프트 삭제 (database.md §7). 활성 목록·상한·신규 장면에서 빠지고, 과거 기록은 보존한다 */
export async function deleteCharacter(userId: AuthenticatedUserId, worldId: string, characterId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockOwnedWorld(tx, userId, worldId);
    const { count } = await tx.character.updateMany({
      where: { id: characterId, worldId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) throw new NotFoundError();
    await bumpChangeSeq(tx, worldId);
  });
}
