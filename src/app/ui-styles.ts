// 화면 공통 UI 규칙 (서버·클라이언트 공용 클래스 문자열). 버튼·입력·카드·링크·제목 크기의 단일 출처다(architecture.md §13.10).
// 색은 globals.css 테마 토큰(로즈 핑크·아이보리)만 쓴다. 의미 색(대화 피드 사건·상태 말풍선, 사망 빨강)은 각 화면에 둔다.

const base = "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium disabled:opacity-50";

/** 보조 동작 (취소·보조·불러오기 등): 테두리 */
export const button = `${base} h-9 border border-foreground/20 px-4 hover:bg-hover`;
/** 주요 동작 (만들기·저장·등록·전체 랜덤): 옅은 로즈 면 + 딥 로즈 글자 */
export const primaryButton = `${base} h-9 border border-primary-soft bg-primary/10 px-4 text-primary-text hover:bg-primary/15`;
/** 화면에서 가장 앞세우는 동작 (사건 일으키기): 딥 로즈 채움 + 흰 글자 */
export const solidButton = `${base} h-9 bg-primary-strong px-4 text-white hover:bg-primary-strong/90`;
/** 삭제 */
export const dangerButton = `${base} h-9 border border-red-600/40 px-4 text-red-600 hover:bg-red-600/10`;
/** 작은 버튼 뼈대 (테두리 색·배경·좌우 여백은 붙이는 쪽이 정한다. 같은 속성을 두 번 주지 않기 위해 분리) */
export const smallButtonBase = "inline-flex h-7 items-center justify-center gap-1 rounded-md border text-xs disabled:opacity-50";
/** 작은 동작 (모달·목록 안 버튼) */
export const smallButton = `${smallButtonBase} border-foreground/20 bg-background px-2.5 hover:bg-hover`;
/** 작은 위험 동작 (목록 안 삭제·취소) */
export const smallDangerButton = `${smallButtonBase} border-red-600/40 bg-background px-2.5 text-red-600 hover:bg-red-600/10`;
/** 원형 아이콘 버튼 (실행 바 재생·일시정지) */
export const primaryIconButton = "flex h-10 w-10 items-center justify-center rounded-full border border-primary-soft bg-primary/10 font-medium text-primary-text hover:bg-primary/15 disabled:opacity-50";

/** 입력칸·textarea */
export const inputClass = "w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm";
/** 모달을 여는 선택 칸 (입력칸과 같은 모양: 성격·배경 선택) */
export const selectButton = `${inputClass} flex items-center justify-between gap-2 text-left hover:border-primary-soft hover:bg-primary/5`;
/** 카드 (패널·목록 상자) */
export const cardClass = "rounded-lg border border-foreground/15 p-4";
/** 글 속 링크 */
export const textLink = "text-primary-text underline";

// 글자 크기: 페이지 제목 2xl → 하위 페이지 제목 xl → 섹션 제목 lg → 모달 제목 base → 카드 제목 sm. 본문 sm, 보조·메타 xs
export const pageTitle = "text-2xl font-semibold";
export const subPageTitle = "text-xl font-semibold";
export const sectionTitle = "text-lg font-semibold";
export const modalTitle = "text-base font-semibold";
export const cardTitle = "text-sm font-semibold";
/** 보조 설명 */
export const helpText = "text-xs text-foreground/60";
/** 오류 문구 (그 자리에 남는다) */
export const errorText = "text-sm text-red-600";
