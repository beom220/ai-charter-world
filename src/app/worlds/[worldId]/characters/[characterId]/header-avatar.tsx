"use client";

import { useEffect, useState } from "react";
import { moodExpression } from "@/lib/avatars";
import { Avatar } from "../../../avatar";
import { CHARACTER_MOOD_EVENT } from "../../world-events";

// 캐릭터 상세 상단(이름·나이·성격 왼쪽)의 프로필 일러스트. 크기는 설정 수정의 일러스트 미리보기(72px)와 같다. 현재 감정 표정이다(감정 없음·모르는 값은 neutral).
// 처음 값은 서버가 주고, 상태창(live-state.tsx)이 SSE로 다시 읽은 감정을 CHARACTER_MOOD_EVENT로 받아 바꾼다(별도 구독·요청 없음).
// 불러오기(state.replaced)는 페이지를 서버에서 다시 그리므로 새 초기값을 받는다.

export function HeaderAvatar({ characterId, avatarId, name, initialMood, dead }: { characterId: string; avatarId: string | null; name: string; initialMood: string | null; dead: boolean }) {
  const [mood, setMood] = useState(initialMood);
  const [propMood, setPropMood] = useState(initialMood);
  if (propMood !== initialMood) {
    setPropMood(initialMood);
    setMood(initialMood);
  }

  useEffect(() => {
    const onMood = (e: Event) => {
      const detail = (e as CustomEvent<{ characterId?: string; mood?: string | null }>).detail;
      if (detail?.characterId === characterId) setMood(detail.mood ?? null);
    };
    window.addEventListener(CHARACTER_MOOD_EVENT, onMood);
    return () => window.removeEventListener(CHARACTER_MOOD_EVENT, onMood);
  }, [characterId]);

  return <Avatar avatarId={avatarId} expression={moodExpression(mood)} name={name} size={72} eager className={`border-2 ${dead ? "border-red-600/40" : "border-primary-soft"}`} />;
}
