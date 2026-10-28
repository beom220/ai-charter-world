-- Phase 7-2-0: 설정 펜싱 카운터. 세계관·캐릭터 설정 변경과 불러오기 때만 올린다 (changeSeq는 복구 지점 판정 전용)
ALTER TABLE "GameState" ADD COLUMN "settingsSeq" INTEGER NOT NULL DEFAULT 0;
