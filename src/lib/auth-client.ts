import { createAuthClient } from "better-auth/react";

// 브라우저용 Better Auth 클라이언트. 같은 origin의 /api/auth를 호출한다.
// 서버 모듈을 import하지 않는다 (클라이언트 경계, architecture.md §5.1).
export const authClient = createAuthClient();
