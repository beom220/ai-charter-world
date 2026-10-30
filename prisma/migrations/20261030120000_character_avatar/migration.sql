-- 캐릭터 프로필 일러스트 ID (config/avatars.ts). 기존 캐릭터는 NULL로 두고 임의 배정하지 않는다(화면은 대체 표시, 수정 시 선택).
-- 같은 세계관 활성 캐릭터끼리의 중복 금지는 World 행 잠금 아래 앱 검증으로 보장한다(활성 6명 상한과 같은 방식).
ALTER TABLE "Character" ADD COLUMN "avatarId" VARCHAR(32);
