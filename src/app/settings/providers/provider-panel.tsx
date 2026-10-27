"use client";

import { useState } from "react";

type Connection = {
  status: "UNVERIFIED" | "ACTIVE" | "INVALID";
  keyLast4: string;
  defaultModel: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
};

type Model = { id: string; displayName: string; inputTokenLimit: number | null; outputTokenLimit: number | null; thinking: boolean; preview: boolean };

type Notice = { kind: "ok" | "error"; text: string } | null;

/** 이번 화면에서 선택에 실패한 모델 표시 (저장하지 않는 화면 상태) */
const FAILED_LABEL: Record<string, string> = {
  GEMINI_MODEL_UNAVAILABLE: "생성 요청 실패",
  GEMINI_QUOTA_EXCEEDED: "할당량 제한 — 나중에 다시 시도",
  GEMINI_MODEL_NOT_FOUND: "찾을 수 없음",
  GEMINI_MODEL_NOT_SUPPORTED: "대화 생성 미지원",
};

const STATUS_LABEL: Record<Connection["status"], string> = {
  UNVERIFIED: "미검증 — 검증이 필요합니다",
  ACTIVE: "검증됨",
  INVALID: "사용 불가 — 키를 확인하세요",
};

const button = "rounded-md border border-foreground/20 px-3 py-1.5 text-sm font-medium hover:bg-foreground/5 disabled:opacity-50";

async function call(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json();
  return { ok: res.ok, json };
}

export function ProviderPanel({ initialConnection }: { initialConnection: Connection | null }) {
  const [connection, setConnection] = useState<Connection | null>(initialConnection);
  const [models, setModels] = useState<Model[]>([]);
  const [failedModels, setFailedModels] = useState<Record<string, string>>({});
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await task();
    } catch {
      setNotice({ kind: "error", text: "요청을 처리하지 못했습니다." });
    } finally {
      setBusy(false);
    }
  }

  const saveKey = () =>
    run(async () => {
      const { ok, json } = await call("/api/providers/gemini", "PUT", { apiKey });
      if (!ok) return setNotice({ kind: "error", text: json.error.message });
      setApiKey("");
      setModels([]);
      setFailedModels({});
      setConnection(json.connection);
      setNotice({ kind: "ok", text: json.created ? "키를 저장했습니다. 검증을 진행하세요." : "키를 교체했습니다. 다시 검증하세요." });
    });

  const verify = () =>
    run(async () => {
      const { ok, json } = await call("/api/providers/gemini/verify", "POST");
      if (!ok) return setNotice({ kind: "error", text: json.error.message });
      setConnection(json.connection);
      setModels(json.models);
      setFailedModels({});
      if (!json.verification.ok) return setNotice({ kind: "error", text: json.verification.message });
      setNotice({
        kind: "ok",
        text: json.modelReselectRequired ? "검증되었습니다. 이전 모델을 이 키로 쓸 수 없어 모델을 다시 선택해야 합니다." : "검증되었습니다.",
      });
    });

  const refreshModels = () =>
    run(async () => {
      const { ok, json } = await call("/api/providers/gemini/models", "GET");
      if (!ok) return setNotice({ kind: "error", text: json.error.message });
      setModels(json.models);
    });

  const selectModel = (id: string) =>
    run(async () => {
      const { ok, json } = await call("/api/providers/gemini/model", "PUT", { model: id });
      if (!ok) {
        const code: string = json.error.code;
        if (code in FAILED_LABEL) setFailedModels((prev) => ({ ...prev, [id]: code }));
        return setNotice({ kind: "error", text: json.error.message });
      }
      setFailedModels((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setConnection(json.connection);
      setNotice({ kind: "ok", text: `기본 모델을 ${id}(으)로 설정했습니다.` });
    });

  const remove = () =>
    run(async () => {
      if (!window.confirm("등록된 키를 삭제할까요? 이 키의 사용량 집계도 함께 삭제됩니다.")) return;
      const { ok, json } = await call("/api/providers/gemini", "DELETE");
      if (!ok) return setNotice({ kind: "error", text: json.error.message });
      setConnection(null);
      setModels([]);
      setNotice({ kind: "ok", text: "키를 삭제했습니다. Google AI Studio에서도 키를 폐기하는 것을 권장합니다." });
    });

  return (
    <div className="flex flex-col gap-6">
      {notice && (
        <p role={notice.kind === "error" ? "alert" : "status"} className={`text-sm ${notice.kind === "error" ? "text-red-600" : "text-green-700"}`}>
          {notice.text}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">연결 상태</h2>
        {connection ? (
          <dl className="grid grid-cols-[8rem_1fr] gap-1 text-sm">
            <dt>상태</dt>
            <dd>{STATUS_LABEL[connection.status]}</dd>
            <dt>키</dt>
            <dd>••••{connection.keyLast4}</dd>
            <dt>기본 모델</dt>
            <dd>{connection.defaultModel ?? "선택 안 됨"}</dd>
            <dt>마지막 검증</dt>
            <dd>{connection.lastVerifiedAt ? new Date(connection.lastVerifiedAt).toLocaleString("ko-KR") : "없음"}</dd>
            {connection.lastErrorCode && (
              <>
                <dt>최근 오류</dt>
                <dd>{connection.lastErrorCode}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-sm">등록된 키가 없습니다.</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{connection ? "키 교체" : "키 등록"}</h2>
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="AIza…"
            aria-label="Gemini API 키"
            className="flex-1 rounded-md border border-foreground/20 px-3 py-1.5 text-sm"
          />
          <button type="button" className={button} onClick={saveKey} disabled={busy || apiKey.trim() === ""}>
            저장
          </button>
        </div>
      </section>

      {connection && (
        <section className="flex flex-wrap gap-2">
          <button type="button" className={button} onClick={verify} disabled={busy}>
            키 검증
          </button>
          <button type="button" className={button} onClick={refreshModels} disabled={busy || connection.status !== "ACTIVE"}>
            모델 목록 새로고침
          </button>
          <button type="button" className={button} onClick={remove} disabled={busy}>
            키 삭제
          </button>
        </section>
      )}

      {models.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">모델 선택</h2>
          <p className="text-xs text-foreground/70">
            이 키로 조회된 모델 목록입니다. 목록에 있어도 생성 요청이 가능하다는 뜻은 아닙니다. 선택하면 모델 확인과 최소 생성 요청(출력 16토큰
            이하)을 1번씩 보내 실제로 쓸 수 있는지 확인하고, 성공한 경우에만 기본 모델로 저장합니다. 소량의 토큰이 사용될 수 있습니다.
          </p>
          <ul className="flex flex-col divide-y divide-foreground/10 text-sm">
            {models.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{m.displayName}</span> <code className="text-xs">{m.id}</code>
                  {m.preview && <span className="ml-1 text-xs text-amber-700">미리보기</span>}
                  {failedModels[m.id] && <span className="ml-1 text-xs text-red-600">{FAILED_LABEL[failedModels[m.id]!]}</span>}
                </span>
                <button type="button" className={button} onClick={() => selectModel(m.id)} disabled={busy || connection?.defaultModel === m.id}>
                  {connection?.defaultModel === m.id ? "선택됨" : "선택"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
