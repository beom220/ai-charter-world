"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const buttonClass =
  "rounded-md border border-foreground/20 px-4 py-2 text-sm font-medium hover:bg-foreground/5 disabled:opacity-50";

export function SignInButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.social({ provider: "google", callbackURL: "/login" });
    // 성공하면 Google로 이동하므로 여기 도달하는 것은 실패뿐이다
    if (error) {
      setError("Google 로그인을 시작하지 못했습니다. 잠시 후 다시 시도하세요.");
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className={buttonClass} onClick={signIn} disabled={pending}>
        Google로 로그인
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    await authClient.signOut();
    router.refresh();
    setPending(false);
  }

  return (
    <button type="button" className={buttonClass} onClick={signOut} disabled={pending}>
      로그아웃
    </button>
  );
}
