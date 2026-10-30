import { z } from "zod";
import { AVATAR_ID_MAX_LENGTH } from "../../../config/avatars";
import { isAvatarForGender } from "@/lib/avatars";
import { snapshotV4Error, snapshotV4Schema, type SnapshotV4 } from "./v4";

// 게임 스냅샷 payload v5. v4 + 캐릭터 프로필 일러스트 ID(avatarId, 구버전 캐릭터는 NULL).
// v1~v4 원본(그리고 checksum)은 그대로 두고 읽을 때 v5로 바꾼다(architecture.md §9.6).
// v4 → v5: avatarId NULL (임의 배정하지 않는다. 화면은 대체 표시, 수정할 때 선택하게 된다).

const characterV5Schema = snapshotV4Schema.shape.characters.element.extend({
  avatarId: z.string().min(1).max(AVATAR_ID_MAX_LENGTH).nullable(),
});

export const snapshotV5Schema = snapshotV4Schema.extend({
  schemaVersion: z.literal(5),
  characters: z.array(characterV5Schema),
});

export type SnapshotV5 = z.infer<typeof snapshotV5Schema>;

export function migrateV4ToV5(p: SnapshotV4): SnapshotV5 {
  return { ...p, schemaVersion: 5, characters: p.characters.map((c) => ({ ...c, avatarId: null })) };
}

/** v4 검사 + 일러스트가 알려진 ID·성별 일치, 활성(삭제되지 않은) 캐릭터끼리 중복 없음. 불러온 뒤에도 같은 세계관 중복 금지를 지킨다 */
export function snapshotV5Error(p: SnapshotV5): string | null {
  const v4 = snapshotV4Error({ ...p, schemaVersion: 4 }); // v4 검사는 버전 값과 무관하다
  if (v4) return v4;
  const active = new Set<string>();
  for (const c of p.characters) {
    if (c.avatarId === null) continue;
    if (!isAvatarForGender(c.avatarId, c.gender)) return "BAD_AVATAR";
    if (c.deletedAt !== null) continue;
    if (active.has(c.avatarId)) return "DUPLICATE_AVATAR";
    active.add(c.avatarId);
  }
  return null;
}
