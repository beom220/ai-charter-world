import Link from "next/link";

// 세계관 화면 공용 (서버·클라이언트 컴포넌트 양쪽에서 import한다).

export const button =
  "rounded-md border border-foreground/20 px-4 py-2 text-sm font-medium hover:bg-hover disabled:opacity-50";

// 주요 동작(생성·저장·확인·전체 랜덤) 버튼: 소프트 핑크 테두리, 옅은 로즈 면, 딥 로즈 글자
const primaryTone = "border border-primary-soft bg-primary/10 font-medium text-primary-text hover:bg-primary/15 disabled:opacity-50";
export const primaryButton = `rounded-md px-4 py-2 text-sm ${primaryTone}`;
export const primaryIconButton = `flex h-10 w-10 items-center justify-center rounded-full ${primaryTone}`;

// 대화 화면 하단 고정 바의 색 버튼: 사건 일으키기(파랑, 사건 메시지 색), 저장(주요 버튼), 불러오기(로즈 테두리)
const solid = "rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-50 sm:px-4";
export const eventButton = `${solid} bg-[#3B82F6] hover:bg-[#2563EB]`;
export const saveButton = `rounded-md px-3 py-2 text-sm sm:px-4 ${primaryTone}`;
export const loadButton =
  "rounded-md border border-primary px-3 py-2 text-sm font-medium text-primary-text hover:bg-primary/10 disabled:opacity-50 sm:px-4";

export function LoginRequired() {
  return (
    <p className="text-sm">
      <Link href="/login" className="text-primary-text underline">
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

export const MOOD_LABEL: Record<string, string> = {
  NEUTRAL: "평온",
  HAPPY: "기쁨",
  EXCITED: "들뜸",
  CALM: "차분",
  SAD: "슬픔",
  ANXIOUS: "불안",
  ANGRY: "분노",
  FEARFUL: "두려움",
  EMBARRASSED: "당황",
  LONELY: "외로움",
  HOPEFUL: "기대",
  TIRED: "지침",
};
