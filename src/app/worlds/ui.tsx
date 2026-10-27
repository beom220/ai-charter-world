import Link from "next/link";

// 세계관 화면 공용 (서버·클라이언트 컴포넌트 양쪽에서 import한다).

export const button =
  "rounded-md border border-foreground/20 px-4 py-2 text-sm font-medium hover:bg-foreground/5 disabled:opacity-50";

export function LoginRequired() {
  return (
    <p className="text-sm">
      <Link href="/login" className="underline">
        로그인
      </Link>
      이 필요합니다.
    </p>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  IDLE: "대기",
  RUNNING: "실행 중",
  PAUSING: "일시정지 중",
  PAUSED: "일시정지",
};
