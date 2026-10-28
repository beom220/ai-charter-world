-- Phase 7-1: 캐릭터 유년기·성년기 배경 (고정 프리셋 ID만 저장, 이름·설명은 config/character-backgrounds.ts)
-- 기존 캐릭터·구버전 세이브 호환을 위해 NULL을 허용한다. 신규 생성·수정 요청의 필수 검증은 앱(Zod·도메인)이 한다.
ALTER TABLE "Character" ADD COLUMN "childhoodBackgroundId" VARCHAR(64);
ALTER TABLE "Character" ADD COLUMN "adulthoodBackgroundId" VARCHAR(64);

-- 성년기 배경은 19세 이상만 가질 수 있다 (앱 검증이 1차, CHECK 위반은 곧 버그)
ALTER TABLE "Character" ADD CONSTRAINT character_adulthood_age CHECK ("adulthoodBackgroundId" IS NULL OR "age" >= 19);
