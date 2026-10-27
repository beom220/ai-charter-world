import "server-only";

// 인증 환경변수 검증. 오류 메시지에는 변수 이름만 담고 값은 절대 담지 않는다.

export const AUTH_ENV_KEYS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

const MIN_SECRET_LENGTH = 32;

export type AuthEnv = {
  secret: string;
  baseURL: string;
  google: { clientId: string; clientSecret: string };
};

export class AuthConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`인증 환경변수 설정 오류: ${problems.join(", ")}. .env.example과 docs/auth-setup.md를 참고하세요.`);
    this.name = "AuthConfigError";
  }
}

export function readAuthEnv(source: Readonly<Record<string, string | undefined>>): AuthEnv {
  const problems: string[] = [];
  const value = (key: (typeof AUTH_ENV_KEYS)[number]) => {
    const v = source[key]?.trim();
    if (!v) problems.push(`${key} 누락`);
    return v ?? "";
  };

  const secret = value("BETTER_AUTH_SECRET");
  const baseURL = value("BETTER_AUTH_URL");
  const clientId = value("GOOGLE_CLIENT_ID");
  const clientSecret = value("GOOGLE_CLIENT_SECRET");

  if (secret && secret.length < MIN_SECRET_LENGTH) {
    problems.push(`BETTER_AUTH_SECRET는 ${MIN_SECRET_LENGTH}자 이상이어야 함`);
  }
  if (baseURL && !/^https?:\/\/[^/\s]+/.test(baseURL)) {
    problems.push("BETTER_AUTH_URL은 http(s):// 로 시작하는 URL이어야 함");
  }
  if (problems.length > 0) throw new AuthConfigError(problems);

  return { secret, baseURL, google: { clientId, clientSecret } };
}
