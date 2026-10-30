import Link from "next/link";
import { Suspense } from "react";
import { LoadingFallback } from "@/app/loading-fallback";
import { getCurrentSession } from "@/server/auth/session";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { getGeminiConnection } from "@/server/domain/providers/gemini-connection";
import { ProviderPanel } from "./provider-panel";

// Gemini API 키 설정 (PRD FR-02 /settings/providers). Phase 3-2 확인용 최소 화면.

export default function ProvidersPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">AI 설정 — Gemini API 키</h1>
      <p className="text-sm text-foreground/70">
        본인의 Gemini API 키만 사용합니다. 키는 서버에서 암호화해 저장하며 화면에는 끝 4자리만 표시합니다. 검증·모델 선택을 누를 때만 Google
        Gemini API로 요청을 보냅니다.
      </p>
      <Suspense fallback={<LoadingFallback />}>
        <ProviderSection />
      </Suspense>
    </main>
  );
}

async function ProviderSection() {
  const session = await getCurrentSession();
  if (!session) {
    return (
      <p className="text-sm">
        <Link href="/login" className="text-primary-text underline">
          로그인
        </Link>
        이 필요합니다.
      </p>
    );
  }
  const connection = await getGeminiConnection(asAuthenticatedUserId(session.user.id));
  return <ProviderPanel initialConnection={connection ? JSON.parse(JSON.stringify(connection)) : null} />;
}
