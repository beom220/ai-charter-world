// 로그 문자열에서 비밀 값을 지운다 (CLAUDE.md 절대 규칙 4).

const REDACTED = "[REDACTED]";

// 값을 몰라도 형태로 알 수 있는 비밀: [패턴, 치환]
const SECRET_PATTERNS: [RegExp, string][] = [
  [/AIza[0-9A-Za-z_-]{20,}/g, REDACTED], // Google API 키
  [/GOCSPX-[0-9A-Za-z_-]+/g, REDACTED], // Google OAuth 클라이언트 비밀
  [/\b(Bearer)\s+[^\s,;]+/gi, `$1 ${REDACTED}`], // Authorization 헤더
  [/\b([\w.-]*(?:session_token|session_data|state))=[^;,\s]+/gi, `$1=${REDACTED}`], // 인증 쿠키 값
];

/** 알려진 비밀 값(환경변수 등)과 비밀 형태의 문자열을 [REDACTED]로 바꾼다. */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
