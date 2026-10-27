-- enforce_same_scope 수정 (20261027100000_same_world_integrity 보완)
-- PL/pgSQL에서 EXECUTE ... INTO는 FOUND를 갱신하지 않는다. 이전 버전은 IF NOT FOUND가 항상 참이 되어
-- 검사 없이 통과했다. 참조 대상의 범위 컬럼(worldId·ownerId·userId)은 모두 NOT NULL이므로,
-- 조회 결과가 NULL이면 "참조 대상 없음"(존재 여부는 FK가 검사)으로 판단한다.

CREATE OR REPLACE FUNCTION enforce_same_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ref_table text := TG_ARGV[0];
  fk_col    text := TG_ARGV[1];
  ref_scope text := TG_ARGV[2];
  own_scope text := TG_ARGV[3];
  ref_id    text := to_jsonb(NEW) ->> fk_col;
  expected  text := to_jsonb(NEW) ->> own_scope;
  actual    text;
BEGIN
  IF ref_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT %I FROM %I WHERE id = $1', ref_scope, ref_table) INTO actual USING ref_id;
  IF actual IS NULL THEN
    RETURN NEW;
  END IF;
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION '% violates scope: %.% must reference % with the same %', TG_NAME, TG_TABLE_NAME, fk_col, ref_table, ref_scope
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
