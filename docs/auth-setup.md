# Google OAuth 설정 절차

> 대상: 로컬 개발 환경에서 실제 Google 로그인을 검증하려는 개발자
> 관련 코드: `src/server/auth/`, `src/app/api/auth/[...all]/route.ts`, `src/app/login/`
> 관련 문서: `docs/architecture.md` §11, `docs/database.md` §3.1

이 서비스는 **Google OAuth만** 쓴다(Better Auth 1.7.14). 이메일·비밀번호 로그인과 다른 소셜 Provider는 비활성화되어 있다.

## 1. Google Cloud Console에서 OAuth 클라이언트 만들기

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 만들거나 선택한다.
2. **API 및 서비스 → OAuth 동의 화면**을 설정한다.
   - 사용자 유형: 외부(External)
   - 앱 이름, 사용자 지원 이메일, 개발자 연락처를 입력한다.
   - 범위(Scope): `openid`, `email`, `profile`만 쓴다. 앱이 요청하는 범위도 이 세 가지다.
   - 게시 상태가 "테스트"이면, 로그인할 Google 계정을 **테스트 사용자**에 추가해야 한다.
3. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
   - 애플리케이션 유형: **웹 애플리케이션**
   - 승인된 자바스크립트 원본: `http://localhost:3000`
   - 승인된 리디렉션 URI: `http://localhost:3000/api/auth/callback/google`
4. 발급된 **클라이언트 ID**와 **클라이언트 보안 비밀번호**를 확인한다. 보안 비밀번호는 채팅·이슈·커밋·스크린샷에 올리지 않는다.

> 리디렉션 URI는 `BETTER_AUTH_URL` + `/api/auth/callback/google`이다. 로컬 dev 서버에서 Better Auth가 만든 인증 URL의 `redirect_uri`로 확인했다(2026-10-27).

## 2. `.env` 설정

`.env`는 Git에서 제외되어 있다(`.gitignore`의 `.env*`). `.env.example`에는 키 이름만 있다.

```bash
# 32자 이상 무작위 값 (세션 쿠키 서명용). 한 번 정하면 바꾸지 않는다 — 바꾸면 기존 세션이 모두 무효가 된다.
openssl rand -base64 32
```

`.env`에 다음 네 값을 추가한다.

| 변수 | 값 |
|---|---|
| `BETTER_AUTH_SECRET` | 위에서 생성한 값 |
| `BETTER_AUTH_URL` | `http://localhost:3000` |
| `GOOGLE_CLIENT_ID` | Google 클라이언트 ID (`….apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | Google 클라이언트 보안 비밀번호 |

- 값이 빠지거나 형식이 틀리면 `/login`에 누락된 **변수 이름**이 표시되고, `/api/auth/*`는 `500 AUTH_NOT_CONFIGURED`를 반환한다. 오류 메시지와 로그에는 값을 담지 않는다.
- `.env`를 고친 뒤에는 dev 서버를 다시 시작한다.

## 3. 실제 로그인 검증 (수동)

```bash
pnpm db:up
pnpm dev
```

| 단계 | 확인 |
|---|---|
| 1 | `http://localhost:3000/login` → "로그인되어 있지 않습니다", "Google로 로그인" 버튼 |
| 2 | 버튼 클릭 → Google 계정 선택 화면(`accounts.google.com`)으로 이동 |
| 3 | 테스트 사용자 계정으로 동의 → `/login`으로 돌아와 "○○ 님으로 로그인되어 있습니다" 표시 |
| 4 | DB 확인: `user` 1행, `account` 1행(`providerId = 'google'`, `password IS NULL`), `session` 1행 |
| 5 | 브라우저 개발자 도구 → 쿠키 `better-auth.session_token`: HttpOnly, SameSite=Lax |
| 6 | "로그아웃" → "로그인되어 있지 않습니다" 표시, `session` 행 삭제 |

DB 확인 예시(비밀 값 컬럼은 조회하지 않는다):

```bash
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select u.email, a.\"providerId\", a.password is null as no_password, (select count(*) from session s where s.\"userId\" = u.id) as sessions from \"user\" u join account a on a.\"userId\" = u.id;"'
```

### 자주 나는 오류

| 증상 | 원인 |
|---|---|
| Google 화면에 `redirect_uri_mismatch` | 콘솔의 리디렉션 URI가 `BETTER_AUTH_URL/api/auth/callback/google`과 다름(포트·http/https·끝 슬래시 확인) |
| `access_denied` / 앱 차단 | 동의 화면이 "테스트" 상태인데 계정이 테스트 사용자에 없음 |
| `/login`에 "인증 설정이 완료되지 않았습니다" | `.env` 값 누락·형식 오류 또는 dev 서버 재시작 전 |
| 로그인 후에도 비로그인으로 보임 | `BETTER_AUTH_URL`과 실제 접속 주소가 다름(`localhost` vs `127.0.0.1`) |

## 4. 배포 시 주의

- `BETTER_AUTH_URL`은 `https://` 주소로 한다. 이때 세션 쿠키는 `__Secure-better-auth.session_token`(Secure·HttpOnly·SameSite=Lax)이 된다.
- Google 콘솔에 배포 도메인의 원본과 리디렉션 URI를 따로 추가한다.
- 비밀 값은 배포 플랫폼의 비밀 관리 기능에 둔다(architecture.md §15).
