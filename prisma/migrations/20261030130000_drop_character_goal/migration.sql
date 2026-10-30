-- 캐릭터 목표(goal) 폐기 (PRD v2.9, 사용자 결정). 입력·조회·프롬프트에서 이미 쓰지 않으며 컬럼을 지운다.
-- 기존 세이브의 목표 값은 스냅샷 v5 이하 원본에 남고, 읽을 때 v6으로 바꾸면서 버린다(lib/snapshot/v6.ts).
ALTER TABLE "Character" DROP COLUMN "goal";
