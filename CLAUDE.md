# CLAUDE.md — AI Character World

이 파일은 이 저장소에서 작업하는 Claude Code를 위한 지침이다. 모든 문서와 설명은 한국어로 쓴다. 코드 식별자는 영어로 쓴다.

## 프로젝트 한 줄 요약

사용자가 만든 세계관과 캐릭터(최대 6명)가 Gemini(사용자 본인 키, BYOK)로 자율 대화하는 웹서비스다. 대화 결과로 감정·관계·기억이 누적되고, 게임 저장·불러오기를 지원한다.

## 기준 문서 (구현 전 반드시 확인)

| 문서 | 역할 |
|---|---|
| `docs/requirements.md` | PRD. 요구사항과 인수 조건의 최종 기준 |
| `docs/architecture.md` | 아키텍처, 엔진, 실행 제어, 확정 결정 D1~D9·A1~A17 |
| `docs/database.md` | Prisma 스키마 초안, 트랜잭션 패턴, 스냅샷, 삭제 정책 |
| `docs/auth-setup.md` | Google OAuth 환경변수 설정과 실연동 검증 절차 |

- 요구사항을 임의로 바꾸지 않는다. 문서와 다르게 구현해야 할 이유가 생기면, 구현을 멈추고 사용자에게 보고한다.
- 설계를 바꿀 때는 세 문서를 함께 갱신해 충돌이 없게 한다. PRD를 바꾸면 PRD §13 변경 이력에 기록한다.

## 절대 규칙 (위반 금지)

1. **BYOK만 사용한다.** 운영자·서버 소유 Gemini 키로 사용자 호출을 대신하지 않는다. MockProvider는 개발·테스트 전용이며, 프로덕션에서 mock 설정이 감지되면 부팅을 실패시킨다.
2. **인증은 Google OAuth만 쓴다**(Better Auth). 이메일·비밀번호 로그인을 추가하지 않는다.
3. **소유권은 서버 데이터 접근 계층에서 검증한다.** 모든 Route Handler와 Server Action은 `requireUser()`로 시작한다. 세계관 하위 리소스는 `world.ownerId` 조건이 포함된 쿼리로만 접근한다. 타인 리소스는 404로 응답한다.
4. **비밀 정보 노출 금지.** API 키, Authorization 헤더, 프롬프트·세계관·캐릭터 컨텍스트 원문을 로그·URL·클라이언트 응답·에러 리포트에 넣지 않는다.
5. **LLM 출력은 제안일 뿐이다.** Zod와 도메인 검증을 통과한 결과만 반영한다. 관계·감정 수치 초과는 clamp, 구조 오류·잘못된 참조는 장면 실패로 처리한다.
6. **장면 = 트랜잭션.** 장면 결과는 `GameState` 행 잠금, `stateVersion` 펜싱, `attemptId` 멱등성을 갖춘 단일 트랜잭션으로만 커밋한다. 실패한 장면은 어떤 확정 상태도 바꾸지 않는다.
7. **실패한 장면은 자동 재시도하지 않는다.** 실패는 건너뛰고 실행을 유지한다. 반복 실패는 키 단위 서킷 브레이커로 억제한다.
   - `@google/genai`는 `httpOptions.retryOptions`를 지정하지 않는다. `generateContent`에는 반드시 `automaticContinuation: false`(SDK 기본값 true는 요청을 반복함)와 `automaticFunctionCalling: { disable: true }`를 넣는다(architecture.md §6.5).
8. **세계관당 활성 캐릭터는 최대 6명**, 캐릭터 컨텍스트는 **300 코드 포인트**까지다. 클라이언트와 서버 양쪽에서 검증한다.
9. **엔진 경계를 지킨다.** `src/server/engine`, `src/server/llm`, `src/server/events`는 `next/*`·`src/app/*`를 import하지 않는다. Worker로 분리할 수 있어야 한다.
   - `server-only`는 **Next.js 전용 서버 어댑터(`src/server/auth/`)에만** 쓴다. engine·llm·events·db·domain·crypto·logging은 실행 환경에 독립적으로 두고 `server-only`·`next/*`·`src/server/auth`를 import하지 않는다(architecture.md §5.1).
   - `server-only`가 없다고 브라우저 import가 허용되는 것은 아니다. `"use client"` 파일과 `src/lib`는 `src/server`·Prisma Client·`server-only`를 import할 수 없다. ESLint 경계 규칙과 `tests/unit/*-boundary.test.ts`로 강제한다.
10. **세이브 스냅샷 구조를 바꾸면** `schemaVersion`을 올리고, 마이그레이터와 이전 버전 픽스처 테스트를 함께 추가한다.

## 기술 스택

Next.js(App Router) · React · TypeScript(strict) · Tailwind CSS · shadcn/ui · Better Auth · PostgreSQL · Prisma · `@google/genai` · Zod · SSE · Vitest · Playwright · Docker Compose

- 라이브러리 버전은 설치 시점의 최신 안정 버전으로 하고, `package.json`에 정확한 버전을 기록한다.
- 새 패키지를 추가하기 전에는 사용자 승인을 받는다.

## 디렉터리 (요약, 상세는 architecture.md §5)

```
src/app/            페이지, Route Handler (api/), SSE 엔드포인트
src/server/         서버 전용. server-only는 auth/(Next.js 어댑터)에만, 나머지는 런타임 독립
  auth/ db/ domain/ engine/ llm/ events/ crypto/ logging/
src/lib/            클라이언트·서버 공용 Zod 스키마, 상수, 타입
config/             limits, pricing, personality-map
prisma/             schema.prisma, migrations/
tests/              unit/ integration/ e2e/
```

## 명령어

Node.js 24 이상(`.nvmrc`), pnpm 10.24.0. 처음에는 `cp .env.example .env` 후 값을 채운다.

```bash
pnpm install              # 의존성 설치 (postinstall에서 prisma generate 실행)
pnpm dev                  # 개발 서버 http://localhost:3000
pnpm typecheck            # next typegen + tsc --noEmit
pnpm lint                 # ESLint (엔진 경계 규칙 포함)
pnpm test                 # 단위 테스트 (tests/unit, DB 불필요)
pnpm test:integration     # 통합 테스트 (tests/integration, DB 필요)
pnpm test:watch           # 단위 테스트 watch
# E2E 테스트              : Playwright 도입 시 추가 (TBD)

pnpm db:up                # Docker PostgreSQL 기동 (healthy까지 대기), 호스트 포트 5433
pnpm db:down              # PostgreSQL 컨테이너 중지·제거 (볼륨 유지)
pnpm db:check             # Prisma로 DB 연결 확인 (SELECT 1)
pnpm db:generate          # Prisma Client 생성 → src/generated/prisma (커밋 안 함)
pnpm db:migrate           # prisma migrate dev (Phase 2부터 사용)
```

## 개발 워크플로

1. 작업 단위를 `docs/` 기준으로 확인한다. 범위가 크면 Plan Mode로 계획을 먼저 승인받는다.
2. 작업을 시작할 때 기존 구현을 확인하고 재사용한다. 변경 범위는 작업 단위에 한정하고, 관련 없는 리팩터링·코드 분석은 하지 않는다.
3. 커밋 전에 아래 "검증 정책"의 필수 검증을 통과시킨다.
4. 커밋은 작업 단위별로 작게 만들고, 메시지는 `type: 요약` 형식으로 쓴다(`feat`, `fix`, `docs`, `test`, `chore`, `refactor`).
5. 작업 단위가 끝나면 커밋한다. 다음 작업은 `/clear` 후 시작할 수 있게 한다. 푸시는 사용자가 요청할 때만 한다.

## 검증 정책 (Phase 4-1부터 적용)

포트폴리오용 MVP다. 검증 깊이보다 핵심 사용자 기능 완성을 우선하고, 토큰 사용량과 작업 시간을 줄인다. 확정 설계와 보안 불변식(절대 규칙)은 그대로 지킨다. 기존 테스트는 삭제하지 않고, 실행 빈도와 신규 작성 범위만 줄인다.

**필수 검증**

1. 변경한 코드의 타입 검사(`pnpm typecheck`)와 ESLint(`pnpm lint`).
2. 신규 기능의 핵심 성공 경로 테스트.
3. 인증·소유권·암호화·DB 데이터 변경이 포함되면, 그 위험과 직접 관련된 실패 테스트.
4. 기능을 실제로 쓸 수 있는지 확인하는 최소한의 동작 검증.

**조건부 검증** (해당할 때만 실행)

| 검증 | 실행 조건 |
|---|---|
| 전체 단위 테스트 (`pnpm test`) | 여러 모듈에 영향을 주는 변경, 기능 묶음 완료 |
| 전체 통합 테스트 (`pnpm test:integration`) | DB 스키마·인증·공통 인프라 변경 |
| 프로덕션 빌드 (`pnpm build`) | 기능 묶음 완료, 배포 준비 |
| 마이그레이션 재현 (`migration-replay.test.ts`) | DB 스키마·마이그레이션 변경 |
| 동시성 테스트 | 공유 상태의 동시 수정·한도 제어 코드 변경 |

그 밖에는 관련 테스트 파일만 실행한다(예: `pnpm vitest run --project integration tests/integration/<file>.test.ts`).

**기본적으로 하지 않는 것**

- 같은 테스트를 여러 번 반복 실행하거나, 기존 테스트 전체를 반복 실행
- 변이 테스트·고의적 결함 주입
- 수십 개의 비슷한 경계값 테스트, 필요 이상의 Mock·테스트 헬퍼 작성
- 테스트 통과 후 검증 범위를 더 넓히는 것
- 장문의 작업 보고서

**예외**: 인증 우회, 타인 데이터 노출, 비밀 키 유출, 데이터 손실 같은 심각한 위험을 발견하면 필요한 검증을 하고 보고한다.

**실행 원칙**

- 관련 테스트를 먼저 고르고, 새 테스트는 최소한으로 추가한다.
- 검증 명령은 원칙적으로 한 번씩만 실행한다. 실패했을 때만 고친 뒤 다시 실행한다.
- 테스트가 통과하면 추가 분석 없이 마무리한다.
- 완료 보고에는 변경 내용, 핵심 검증 결과, 남은 문제, 커밋 해시만 간결하게 쓴다. 코드 작성과 무관한 긴 설명·분석은 하지 않는다.

## 코딩 규칙

- TypeScript `strict`를 쓴다. `any`는 쓰지 않는다. 외부 입력(요청 본문, LLM 응답, 스냅샷 payload)은 반드시 Zod로 파싱한다.
- 수치 상한·간격·보관 기간 같은 정책 값은 `config/limits.ts`에 모은다. 하드코딩하지 않는다.
- 상태를 바꾸는 DB 작업은 `prisma.$transaction` 인터랙티브 트랜잭션으로 처리한다. 잠금 순서는 **World → GameState**다.
- 시간은 UTC로 저장한다. 예외로 일일 사용량 날짜만 Asia/Seoul(KST)로 계산한다.
- 사용자에게 보이는 문구는 한국어로 쓴다. AI 생성 대사는 "허구의 캐릭터 발화"로 UI에서 구분한다.
- 요금 관련 문구에 "영구 무료" 같은 표현을 쓰지 않는다. 비용은 "예상치"로 표시한다.

## 테스트 규칙

- 엔진 테스트는 MockProvider로 작성한다. 실제 Gemini 호출은 자동 테스트에 넣지 않는다(Phase 3·5 수동 스파이크만).
- 다음은 반드시 통합 테스트로 검증한다. 해당 기능을 처음 구현하거나 그 코드를 바꿀 때 작성·실행한다(실행 빈도는 위 "검증 정책"을 따른다):
  - 소유권 우회
  - 6명 동시 생성
  - 펜싱과 멱등 커밋
  - lease 경쟁
  - 저장·불러오기·초기화 직렬화
  - 서버 재시작 복구와 중복 API 호출 0건(architecture.md §14 필수 복구 테스트)
  - 동일 세계관·동일 사용자 범위 제약의 INSERT·UPDATE 거부(`tests/integration/scope-matrix.test.ts`)
  - 새 DB 전체 마이그레이션 재현과 개발 DB 카탈로그 일치(`tests/integration/migration-replay.test.ts`). 새 마이그레이션도 이 테스트를 통과해야 한다
- PRD §11 MVP 승인 시나리오는 Playwright E2E로 유지한다.

## 하지 말 것

- 문서에 없는 기능을 추가하거나, 확정된 수치(6명, 300자, 15/5/1초, ±5/±20, 20슬롯, 10MB, 60초 등)를 바꾸지 않는다.
- 사용자 승인 없이 패키지를 설치하거나, 프로젝트 구조를 생성하거나, 마이그레이션을 리셋하지 않는다.
- `.env*` 파일과 비밀 값을 커밋하지 않는다. 필요한 변수는 `.env.example`에 키 이름만 적는다.
