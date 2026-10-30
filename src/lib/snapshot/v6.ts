import { z } from "zod";
import { snapshotV5Error, snapshotV5Schema, type SnapshotV5 } from "./v5";

// 게임 스냅샷 payload v6 (PRD v2.9). v5에서 캐릭터 목표(goal)를 뺐다(DB 컬럼 Character.goal 삭제, 마이그레이션 20261030130000).
// v1~v5 원본(그리고 checksum)은 그대로 두고 읽을 때 v6으로 바꾼다(architecture.md §9.6). v5 → v6: 목표 값은 버린다(폐기된 기능).

const characterV6Schema = snapshotV5Schema.shape.characters.element.omit({ goal: true });

export const snapshotV6Schema = snapshotV5Schema.extend({
  schemaVersion: z.literal(6),
  characters: z.array(characterV6Schema),
});

export type SnapshotV6 = z.infer<typeof snapshotV6Schema>;

export function migrateV5ToV6(p: SnapshotV5): SnapshotV6 {
  return { ...p, schemaVersion: 6, characters: p.characters.map(({ goal, ...c }) => (void goal, c)) };
}

/** v5 검사(목표와 무관) 그대로 */
export function snapshotV6Error(p: SnapshotV6): string | null {
  return snapshotV5Error({ ...p, schemaVersion: 5, characters: p.characters.map((c) => ({ ...c, goal: null })) });
}
