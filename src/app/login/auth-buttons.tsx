"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { button, errorText, primaryButton } from "../ui-styles";


export function SignInButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.social({ provider: "google", callbackURL: "/worlds" });
    // 성공하면 Google로 이동하므로 여기 도달하는 것은 실패뿐이다
    if (error) {
      setError("Google 로그인을 시작하지 못했습니다. 잠시 후 다시 시도하세요.");
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className={primaryButton} onClick={signIn} disabled={pending}>
        Google로 로그인
      </button>
      {error && (
        <p role="alert" className={errorText}>
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
    <button type="button" className={button} onClick={signOut} disabled={pending}>
      로그아웃
    </button>
  );
}
