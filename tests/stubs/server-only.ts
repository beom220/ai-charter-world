// Vitest는 React Server 환경이 아니므로 server-only를 빈 모듈로 대체한다 (vitest.config.ts alias).
// 실제 앱에서 클라이언트 import 차단은 Next.js(server-only)와 ESLint 경계 규칙이 맡는다.
export {};
