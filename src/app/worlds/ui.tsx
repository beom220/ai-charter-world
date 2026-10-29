import Link from "next/link";

// 세계관 화면 공용 (서버·클라이언트 컴포넌트 양쪽에서 import한다).

export const button =
  "rounded-md border border-foreground/20 bg-card px-4 py-2 text-sm font-medium hover:bg-blush/50 disabled:opacity-50";

// 주요 동작(생성·저장·확인) 버튼: 딥 로즈 채움에 흰 글자(로즈 핑크는 흰 글자 대비가 낮아 hover에만 쓴다)
export const primaryButton =
  "rounded-md bg-primary-strong px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:opacity-50";

// 대화 화면 하단 고정 바의 색 버튼: 사건 일으키기(파랑, 사건 메시지 색), 저장(딥 로즈 채움), 불러오기(로즈 테두리)
const solid = "rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-50 sm:px-4";
export const eventButton = `${solid} bg-[#3B82F6] hover:bg-[#2563EB]`;
export const saveButton = `${solid} bg-primary-strong hover:bg-primary`;
export const loadButton =
  "rounded-md border border-primary bg-card px-3 py-2 text-sm font-medium text-primary-strong hover:bg-blush/50 disabled:opacity-50 sm:px-4";

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
