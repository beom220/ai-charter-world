// 서버 오류 로그. 오류 객체·메시지에는 요청 데이터(키·암호문·쿼리 인자)가 섞일 수 있으므로
// 기본은 오류 이름과 코드만 남긴다 (CLAUDE.md 절대 규칙 4).

export function logServerError(scope: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  console.error(`[${scope}] ${name}${code ? ` (${code})` : ""}`);
}
