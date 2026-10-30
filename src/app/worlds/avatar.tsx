"use client";

import { memo, useState } from "react";
import type { AvatarExpression } from "../../../config/avatars";
import { avatarSrc } from "@/lib/avatars";

// 캐릭터 프로필 일러스트 (원형, 고정 크기). 어떤 표정을 쓸지는 부르는 쪽이 정한다:
// 생성·편집 화면과 대화창은 neutral, 상단 고정 프로필과 캐릭터 상세는 현재 감정 표정(lib/avatars.ts moodExpression).
// - width·height를 고정해 레이아웃 이동이 없고, object-contain으로 비율을 유지한다. 지연 로딩한다(일괄 프리로드 없음).
// - 표정 파일을 못 읽으면 neutral로, neutral도 없거나 avatarId가 없으면(기존 데이터) 이름 첫 글자 원으로 대체한다.

export const Avatar = memo(function Avatar({
  avatarId,
  expression = "neutral",
  name,
  size,
  className = "",
  eager = false,
}: {
  avatarId: string | null | undefined;
  expression?: AvatarExpression;
  name: string;
  size: number;
  className?: string;
  /** 첫 화면 위쪽에 바로 보이는 이미지(상단 고정 프로필·상세 프로필)는 지연 로딩하지 않는다 */
  eager?: boolean;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const wanted = avatarSrc(avatarId, expression);
  const neutral = avatarSrc(avatarId, "neutral");
  const src = wanted && !failed.has(wanted) ? wanted : neutral && !failed.has(neutral) ? neutral : null;
  const box = `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-pastel ${className}`;
  if (!src) {
    return (
      <span aria-hidden className={`${box} font-semibold text-primary-text`} style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) }}>
        {Array.from(name.trim())[0] ?? "?"}
      </span>
    );
  }
  return (
    <span aria-hidden className={box} style={{ width: size, height: size }}>
      {/* 정적 WebP(512×512)를 그대로 쓴다. next/image 최적화 경로를 거치지 않아도 되는 고정 에셋이다 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        draggable={false}
        className="h-full w-full object-contain"
        onError={() => setFailed((prev) => new Set(prev).add(src))}
      />
    </span>
  );
});
