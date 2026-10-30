import Link from "next/link";
import { textLink } from "../ui-styles";

// 세계관 화면 공용 (서버·클라이언트 컴포넌트 양쪽에서 import한다).

// 버튼·입력·제목 등 공용 클래스는 src/app/ui-styles.ts가 단일 출처다(여기서 다시 내보낸다)
export { button, primaryButton, primaryIconButton, solidButton, dangerButton, smallButton, smallDangerButton } from "../ui-styles";

export function LoginRequired() {
  return (
    <p className="text-sm">
      <Link href="/login" className={textLink}>
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
