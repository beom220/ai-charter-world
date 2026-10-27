// 서버 계층 공통 오류. Route Handler가 HTTP 상태로 변환한다.
// 메시지는 사용자에게 보일 수 있으므로 내부 정보(리소스 존재 여부, 비밀 값)를 담지 않는다.

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 인증되지 않은 요청 (401) */
export class UnauthorizedError extends AppError {
  constructor() {
    super(401, "UNAUTHORIZED", "로그인이 필요합니다.");
  }
}

/** 잘못된 요청 본문 (400). message는 사용자에게 보여도 되는 문구만 넣는다. */
export class BadRequestError extends AppError {
  constructor(message = "요청 형식이 올바르지 않습니다.") {
    super(400, "INVALID_REQUEST", message);
  }
}

/** 허용되지 않은 출처의 상태 변경 요청 (403) */
export class ForbiddenError extends AppError {
  constructor() {
    super(403, "FORBIDDEN", "허용되지 않은 요청입니다.");
  }
}

/** 없거나 타인 소유인 리소스 (404). 둘을 구분하지 않아 존재 여부를 노출하지 않는다. */
export class NotFoundError extends AppError {
  constructor() {
    super(404, "NOT_FOUND", "요청한 리소스를 찾을 수 없습니다.");
  }
}

/** 요청 본문이 한도(10MB)를 넘음 (413, architecture.md §11.3) */
export class PayloadTooLargeError extends AppError {
  constructor() {
    super(413, "PAYLOAD_TOO_LARGE", "요청 크기가 10MB를 넘었습니다.");
  }
}

/** 현재 상태와 충돌하는 요청 (409). 예: 세계관당 활성 캐릭터 상한 */
export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}
