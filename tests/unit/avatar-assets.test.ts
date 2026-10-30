import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AVATAR_EXPRESSIONS, AVATAR_IDS, FEMALE_AVATAR_IDS, MALE_AVATAR_IDS } from "../../config/avatars";

// 캐릭터 일러스트 에셋 (public/characters): 폴더 23개(여 17·남 6) × 표정 8 = 184개, 이름·WebP·512×512·알파.
// 패키지 없이 RIFF/WebP 헤더만 읽는다(VP8X 캔버스·알파 플래그, VP8L 크기·알파 힌트). 실제 픽셀 투명도는 디코딩하지 않는다.

const ROOT = join(process.cwd(), "public", "characters");

function webpInfo(buf: Buffer): { webp: boolean; width: number; height: number; alpha: boolean } {
  const webp = buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { webp, alpha: (buf[20]! & 0x10) !== 0, width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { webp, width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff), alpha: ((b >> 28) & 1) === 1 };
  }
  return { webp, width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, alpha: false }; // VP8 (손실, 알파 없음)
}

describe("캐릭터 일러스트 에셋", () => {
  it("여성 17종·남성 6종 폴더만 있고, 각 폴더에 표정 8개 파일만 있다 (총 184개)", () => {
    expect(FEMALE_AVATAR_IDS).toHaveLength(17);
    expect(MALE_AVATAR_IDS).toHaveLength(6);
    expect(readdirSync(ROOT).filter((d) => !d.startsWith(".")).sort()).toEqual([...AVATAR_IDS].sort());
    let count = 0;
    for (const id of AVATAR_IDS) {
      const files = readdirSync(join(ROOT, id)).filter((f) => !f.startsWith("."));
      expect(files.sort(), id).toEqual(AVATAR_EXPRESSIONS.map((e) => `${e}.webp`).sort());
      count += files.length;
    }
    expect(count).toBe(184);
  });

  it("모든 파일이 512×512 WebP이고 알파 채널이 있다", () => {
    const bad: string[] = [];
    for (const id of AVATAR_IDS) {
      for (const e of AVATAR_EXPRESSIONS) {
        const path = join(ROOT, id, `${e}.webp`);
        if (!existsSync(path)) {
          bad.push(`${id}/${e}: 없음`);
          continue;
        }
        const info = webpInfo(readFileSync(path));
        if (!info.webp || info.width !== 512 || info.height !== 512 || !info.alpha) bad.push(`${id}/${e}: ${JSON.stringify(info)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
