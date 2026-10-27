import { Suspense } from "react";
import { AuthConfigError } from "@/server/auth/env";
import { getCurrentSession } from "@/server/auth/session";
import { SignInButton, SignOutButton } from "./auth-buttons";

// 로그인·로그아웃 확인용 최소 화면 (Phase 2-3). 서비스 UI는 이후 단계에서 만든다.

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">로그인</h1>
      <Suspense fallback={<p className="text-sm text-foreground/70">로그인 상태 확인 중…</p>}>
        <SessionStatus />
      </Suspense>
    </main>
  );
}

async function SessionStatus() {
  let session;
  try {
    session = await getCurrentSession();
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return (
        <p role="alert" className="text-sm text-red-600">
          인증 설정이 완료되지 않았습니다: {error.problems.join(", ")}
        </p>
      );
    }
    throw error;
  }

  if (!session) {
    return (
      <section className="flex flex-col gap-3">
        <p className="text-sm">로그인되어 있지 않습니다.</p>
        <SignInButton />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm">
        <span className="font-medium">{session.user.name}</span> ({session.user.email}) 님으로 로그인되어 있습니다.
      </p>
      <SignOutButton />
    </section>
  );
}
