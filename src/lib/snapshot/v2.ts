import { z } from "zod";
import { findBackground, requiresAdulthood } from "../../../config/character-backgrounds";
import { snapshotV1Schema, type SnapshotV1 } from "./v1";

// 게임 스냅샷 payload v2 (Phase 7-1). v1 + 캐릭터 배경 프리셋 ID(유년기·성년기, 구버전 캐릭터는 NULL).
// v1은 저장된 원본(그리고 checksum)을 그대로 두고, 읽을 때 migrateV1ToV2로 배경을 NULL로 채워 v2로 바꾼다(architecture.md §9.6).

const backgroundId = z.string().min(1).max(64).nullable();

const characterV2Schema = snapshotV1Schema.shape.characters.element.extend({
  childhoodBackgroundId: backgroundId,
  adulthoodBackgroundId: backgroundId,
});

export const snapshotV2Schema = snapshotV1Schema.extend({
  schemaVersion: z.literal(2),
  characters: z.array(characterV2Schema),
});

export type SnapshotV2 = z.infer<typeof snapshotV2Schema>;

/** v1 → v2: 배경이 없던 시절의 캐릭터는 배경 NULL (조회·복원은 되고, 수정할 때 선택하게 된다) */
export function migrateV1ToV2(p: SnapshotV1): SnapshotV2 {
  return { ...p, schemaVersion: 2, characters: p.characters.map((c) => ({ ...c, childhoodBackgroundId: null, adulthoodBackgroundId: null })) };
}

/** 배경 ID가 알려진 프리셋인지, 성년기 배경이 19세 이상에게만 있는지. 문제가 있으면 고정 코드 */
export function snapshotBackgroundError(p: SnapshotV2): string | null {
  for (const c of p.characters) {
    if (c.childhoodBackgroundId !== null && !findBackground(c.childhoodBackgroundId, "CHILDHOOD")) return "BAD_BACKGROUND";
    if (c.adulthoodBackgroundId !== null && (!findBackground(c.adulthoodBackgroundId, "ADULTHOOD") || c.age === null || !requiresAdulthood(c.age))) return "BAD_BACKGROUND";
  }
  return null;
}
