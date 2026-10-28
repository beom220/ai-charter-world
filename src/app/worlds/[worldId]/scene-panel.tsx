"use client";

import { useState } from "react";
import { SCENE_PARTICIPANTS_MIN } from "../../../../config/limits";
import { button } from "../ui";
import { send } from "../world-form";

// 대화 장면 생성 (Phase 5-1). 버튼을 누르면 서버가 활성 캐릭터 중 2~3명을 골라 Gemini가 장면 1개를 만든다.
// 모든 발언은 왼쪽 정렬로 표시하고, 사용자 입력창·감정/관계/기억 변화 알림은 두지 않는다.

type Message = { turnIndex: number; speakerName: string; dialogue: string; actionIntent: string | null; emotionCue: string | null };
export type SceneItem = { id: string; seq: number; title: string; summary: string; contextTruncated: boolean; messages: Message[] };

export function ScenePanel({ worldId, activeCount, initialScenes }: { worldId: string; activeCount: number; initialScenes: SceneItem[] }) {
  const [scenes, setScenes] = useState<SceneItem[]>(initialScenes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const { ok, json } = await send(`/api/worlds/${worldId}/scenes`, "POST");
      if (!ok) return setError(json?.error?.message ?? "장면을 만들지 못했습니다.");
      setScenes((prev) => [json.scene, ...prev]);
    } catch {
      setError("장면을 만들지 못했습니다. 네트워크 상태를 확인하세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border-t border-foreground/10 pt-6">
      <h2 className="text-lg font-semibold">대화 장면</h2>
      {activeCount < SCENE_PARTICIPANTS_MIN ? (
        <p className="text-sm text-foreground/70">대화하려면 캐릭터가 {SCENE_PARTICIPANTS_MIN}명 이상 필요합니다.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={button} onClick={generate} disabled={busy}>
              {busy ? "생성 중…" : "대화 장면 생성"}
            </button>
            <span className="text-xs text-foreground/60">참여 캐릭터는 자동으로 정해집니다. 누를 때마다 Gemini API를 1회 호출합니다(본인 키 사용).</span>
          </div>
          {busy && (
            <p role="status" className="text-sm text-foreground/70">
              Gemini가 장면을 쓰고 있습니다. 최대 1분 정도 걸릴 수 있습니다.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
        </>
      )}

      {scenes.length > 0 && (
        <ol className="flex flex-col gap-4">
          {scenes.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 rounded-md border border-foreground/15 p-4">
              <div>
                <h3 className="font-medium">
                  #{s.seq} {s.title}
                </h3>
                <p className="text-xs text-foreground/60">허구의 캐릭터 발화 · AI 생성</p>
              </div>
              <ul className="flex flex-col gap-2 text-left">
                {s.messages.map((m) => (
                  <li key={m.turnIndex} className="flex flex-col items-start">
                    <span className="text-xs font-semibold text-foreground/70">
                      {m.speakerName}
                      {m.emotionCue && <span className="font-normal"> · {m.emotionCue}</span>}
                    </span>
                    <p className="max-w-[90%] rounded-lg bg-foreground/5 px-3 py-2 text-sm break-words whitespace-pre-wrap">{m.dialogue}</p>
                    {m.actionIntent && <span className="text-xs text-foreground/60 italic">({m.actionIntent})</span>}
                  </li>
                ))}
              </ul>
              {s.contextTruncated && <p className="text-xs text-foreground/60">세계관 컨텍스트 일부가 이번 장면에 반영되지 않았을 수 있습니다.</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
