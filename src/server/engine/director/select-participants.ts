import { SCENE_PARTICIPANTS_MAX, SCENE_PARTICIPANTS_MIN } from "../../../../config/limits";

// 장면 참가자 선정 (SceneDirector의 최소판). 런타임 독립 순수 함수.
// 현재는 활성 캐릭터 중 2~3명을 무작위로 고른다. 이후 감정·관계·기억·사건을 고려한 선정으로 이 함수를 교체한다.
// 후보는 호출자가 활성(삭제되지 않은) 캐릭터만 넘긴다. 2명 미만이면 null.

export function selectSceneParticipants<T>(candidates: readonly T[], random: () => number = Math.random): T[] | null {
  if (candidates.length < SCENE_PARTICIPANTS_MIN) return null;
  const max = Math.min(SCENE_PARTICIPANTS_MAX, candidates.length);
  const count = SCENE_PARTICIPANTS_MIN + Math.floor(random() * (max - SCENE_PARTICIPANTS_MIN + 1));
  // Fisher–Yates 부분 셔플
  const pool = [...candidates];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}
