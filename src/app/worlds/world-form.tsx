"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { MAX_REQUEST_BODY_BYTES, WORLD_NAME_MAX_LENGTH } from "../../../config/limits";
import { worldInputSchema } from "@/lib/schemas/world";
import Link from "next/link";
import { SettingsLockedNotice, useSettingsEditable } from "./settings-lock";
import { button } from "./ui";

// 세계관 생성·수정 폼과 삭제 확인 대화상자 (PRD FR-03). 최소 UI.

type Initial = { id: string; name: string; worldContext: string } | null;

export async function send(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ok: res.ok, json: await res.json().catch(() => null) };
}

export function WorldForm({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [worldContext, setWorldContext] = useState(initial?.worldContext ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const editable = useSettingsEditable(initial?.id ?? null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const parsed = worldInputSchema.safeParse({ name, worldContext });
    if (!parsed.success) return setNotice({ kind: "error", text: parsed.error.issues[0]?.message ?? "입력을 확인하세요." });
    if (new Blob([JSON.stringify(parsed.data)]).size > MAX_REQUEST_BODY_BYTES) {
      return setNotice({ kind: "error", text: "요청 크기가 10MB를 넘었습니다." });
    }

    setBusy(true);
    try {
      const { ok, json } = initial
        ? await send(`/api/worlds/${initial.id}`, "PATCH", parsed.data)
        : await send("/api/worlds", "POST", parsed.data);
      if (!ok) return setNotice({ kind: "error", text: json?.error?.message ?? "요청을 처리하지 못했습니다." });
      if (!initial) return router.push(`/worlds/${json.world.id}`);
      setNotice({ kind: "ok", text: json.changed ? "저장했습니다. 다음 장면부터 반영됩니다." : "변경된 내용이 없습니다." });
      router.refresh();
    } catch {
      setNotice({ kind: "error", text: "요청을 처리하지 못했습니다." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">세계관 이름</span>
        <input
          className="rounded-md border border-foreground/20 bg-transparent px-3 py-2"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={WORLD_NAME_MAX_LENGTH * 2}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">세계관 컨텍스트</span>
        <span className="text-foreground/60">배경·규칙·현재 상황 등 자유롭게 적으세요. 글자 수 제한은 없습니다(전송 최대 10MB).</span>
        <textarea
          className="min-h-64 rounded-md border border-foreground/20 bg-transparent px-3 py-2"
          value={worldContext}
          onChange={(e) => setWorldContext(e.target.value)}
        />
        <span className="text-right text-xs text-foreground/60">{[...worldContext].length.toLocaleString()}자</span>
      </label>
      {initial && (
        <p className="text-xs text-foreground/60">
          설정을 바꿔도 지난 대화·감정·관계·기억은 그대로 남습니다. 배경을 통째로 다른 이야기로 바꾸면 지난 대화와 어긋날 수 있으니,
          완전히 다른 이야기는{" "}
          <Link href="/worlds/new" className="underline">
            새 세계관
          </Link>
          으로 만드는 것을 권장합니다.
        </p>
      )}
      {!editable && <SettingsLockedNotice />}
      <div className="flex items-center gap-3">
        <button type="submit" className={button} disabled={busy || !editable}>
          {initial ? "저장" : "만들기"}
        </button>
        {notice && (
          <p role={notice.kind === "error" ? "alert" : "status"} className={notice.kind === "error" ? "text-sm text-red-600" : "text-sm"}>
            {notice.text}
          </p>
        )}
      </div>
    </form>
  );
}

export function DeleteWorldButton({ worldId, worldName }: { worldId: string; worldName: string }) {
  return (
    <ConfirmDeleteButton
      label="세계관 삭제"
      title="세계관을 삭제할까요?"
      path={`/api/worlds/${worldId}`}
      redirectTo="/worlds"
    >
      <strong>{worldName}</strong>의 캐릭터, 진행 기록, 모든 세이브 슬롯과 자동저장이 함께 삭제됩니다. 실행 중이면 중지됩니다. 삭제한 뒤에는
      되돌릴 수 없습니다.
    </ConfirmDeleteButton>
  );
}

/** 삭제 확인 대화상자. 확인을 누를 때만 DELETE 요청을 보낸다 */
export function ConfirmDeleteButton({
  label,
  title,
  path,
  redirectTo,
  lockWorldId = null,
  children,
}: {
  label: string;
  title: string;
  path: string;
  redirectTo: string;
  /** 설정 변경으로 취급해 실행 중에는 막을 세계관 (캐릭터 삭제) */
  lockWorldId?: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const editable = useSettingsEditable(lockWorldId);
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    setBusy(true);
    setError(null);
    try {
      const { ok, json } = await send(path, "DELETE");
      if (!ok) return setError(json?.error?.message ?? "삭제하지 못했습니다.");
      dialog.current?.close();
      router.push(redirectTo);
      router.refresh();
    } catch {
      setError("삭제하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={`${button} text-red-600`} onClick={() => dialog.current?.showModal()} disabled={!editable}>
        {label}
      </button>
      <dialog ref={dialog} className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-lg bg-background p-6 text-foreground backdrop:bg-black/50">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm">{children}</p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={button} onClick={() => dialog.current?.close()} disabled={busy}>
            취소
          </button>
          <button type="button" className={`${button} text-red-600`} onClick={confirmDelete} disabled={busy}>
            삭제
          </button>
        </div>
      </dialog>
    </>
  );
}
