// 자동 사건 프리셋 24종 (Phase 7-2 명세 §3). 클라이언트·서버 공용 단일 소스.
// - ID는 영구 식별자다. DB(WorldEvent.presetId·WorldEventPeriod.presetId)와 세이브에는 ID만 저장한다. 항목을 임의로 바꾸거나 더하지 않는다.
// - 장면 수로 강제 종료하지 않는다(sceneBudget 없음). 이야기상 해결·완화·실패·타협·위협 소멸이 있어야 RESOLVED가 된다.
// - urgent: 눈앞의 긴급 위험(맹수 습격·급성 부상 등). 오래된 사건보다 먼저 단기 대응할 수 있지만 오래된 사건을 지우지 않는다.
// - fallbackId: 생물이 존재할 수 없는 세계관이면 이 프리셋으로 결정적으로 대체한다(추가 LLM 판정 호출 없음, 장면 생성 응답이 대체 여부를 알린다).

export type EventCategory = "CREATURE" | "ENVIRONMENT" | "HEALTH" | "SURVIVAL" | "DISCOVERY" | "SOCIAL" | "DILEMMA";
export type EventIntensity = "LOW" | "MEDIUM" | "HIGH";
export type EventPreset = {
  id: string;
  category: EventCategory;
  title: string;
  description: string;
  intensity: EventIntensity;
  urgent: boolean;
  fallbackId: string | null;
};

export const EVENT_CATEGORY_LABEL: Record<EventCategory, string> = {
  CREATURE: "생물",
  ENVIRONMENT: "자연환경",
  HEALTH: "사고·질병",
  SURVIVAL: "자원·생존",
  DISCOVERY: "발견",
  SOCIAL: "방문자·사회",
  DILEMMA: "선택",
};

export const EVENT_INTENSITY_LABEL: Record<EventIntensity, string> = { LOW: "낮음", MEDIUM: "보통", HIGH: "높음" };

const P = (id: string, category: EventCategory, title: string, description: string, intensity: EventIntensity, urgent = false, fallbackId: string | null = null): EventPreset => ({
  id,
  category,
  title,
  description,
  intensity,
  urgent,
  fallbackId,
});

export const EVENT_PRESETS: readonly EventPreset[] = [
  // 생물 (5) — 생물이 불가능한 세계관이면 fallbackId로 대체
  P("creature_predator_appears", "CREATURE", "맹수 출현", "현재 환경에서 있을 법한 호랑이·곰·사자·맹수 또는 상응하는 포식 생물이 활동 구역에 나타난다. 실제 종은 세계관에 맞춰 선택한다.", "HIGH", true, "dilemma_risky_choice"),
  P("creature_attack", "CREATURE", "야생동물 습격", "공격적인 야생동물 한 마리 또는 무리가 거점·구성원을 위협하거나 공격한다.", "HIGH", true, "health_work_accident"),
  P("creature_unknown", "CREATURE", "정체불명 생물 발견", "익숙하지 않은 생물의 흔적·울음·움직임을 발견한다.", "MEDIUM", false, "discovery_traces"),
  P("creature_territory", "CREATURE", "동물의 영역 침범", "탐색이나 이동 중 위험한 동물의 서식지나 영역에 들어선다.", "MEDIUM", false, "environment_blocked_route"),
  P("creature_migration", "CREATURE", "동물 떼의 이동", "동물 무리의 이동이 거점·식량·이동 경로에 영향을 준다.", "MEDIUM", false, "survival_food_shortage"),
  // 자연환경 (4)
  P("environment_extreme_weather", "ENVIRONMENT", "극심한 기상 변화", "폭풍·폭설·폭염·한파 등 기온 또는 날씨의 급격한 변화가 찾아온다.", "HIGH", true),
  P("environment_disaster", "ENVIRONMENT", "자연재해 발생", "지진·산사태·홍수 등 환경에 어울리는 자연재해가 발생한다.", "HIGH", true),
  P("environment_contamination", "ENVIRONMENT", "환경 오염", "식수·공기·주변 환경에 오염 위험이 발생한다.", "MEDIUM"),
  P("environment_blocked_route", "ENVIRONMENT", "이동 경로 차단", "붕괴·침수·낙석 등으로 중요한 이동 경로가 막힌다.", "MEDIUM"),
  // 사고·질병 (3)
  P("health_injury", "HEALTH", "예기치 못한 부상", "구성원 한 명이 사고 등으로 다친다.", "MEDIUM", true),
  P("health_illness", "HEALTH", "질병 발생", "구성원 중 누군가 질병 증상을 보이기 시작한다.", "MEDIUM"),
  P("health_work_accident", "HEALTH", "위험한 작업 사고", "작업·탐험 도중 사고가 발생해 구조·치료가 필요해진다.", "HIGH", true),
  // 자원·생존 (4)
  P("survival_food_shortage", "SURVIVAL", "식량 부족", "식량 공급 감소로 확보·분배 대책이 필요해진다.", "MEDIUM"),
  P("survival_water_crisis", "SURVIVAL", "식수 위기", "안전하게 마실 수 있는 물이 부족해진다.", "HIGH"),
  P("survival_equipment_failure", "SURVIVAL", "주요 장비 고장", "중요한 장비나 시설이 고장 나 활동에 차질이 생긴다.", "MEDIUM"),
  P("survival_supplies_missing", "SURVIVAL", "물자 분실", "보관하던 중요한 물자가 사라진다.", "MEDIUM"),
  // 발견 (3)
  P("discovery_traces", "DISCOVERY", "수상한 흔적 발견", "누군가 또는 무언가가 남긴 의문의 흔적을 발견한다.", "LOW"),
  P("discovery_location", "DISCOVERY", "미지의 장소 발견", "아직 탐색하지 않은 장소나 공간을 발견한다.", "LOW"),
  P("discovery_object", "DISCOVERY", "정체불명의 물건 발견", "출처나 용도를 알 수 없는 물건을 발견한다.", "LOW"),
  // 방문자·사회 (3)
  P("social_visitor", "SOCIAL", "낯선 방문자", "외부에서 예상하지 못한 인물이 찾아온다.", "MEDIUM"),
  P("social_rumor", "SOCIAL", "불길한 소문", "구성원 사이에 불안과 의심을 부르는 소문이 퍼진다.", "LOW"),
  P("social_conflict", "SOCIAL", "구성원 간 충돌", "서로 다른 판단·감정으로 말다툼이나 물리적 충돌이 일어날 수 있다. 반드시 폭행으로 귀결되지 않는다.", "MEDIUM"),
  // 선택 (2)
  P("dilemma_risky_choice", "DILEMMA", "위험한 선택", "목표를 달성하려면 상당한 위험을 감수할지 결정해야 한다.", "HIGH"),
  P("dilemma_resource_allocation", "DILEMMA", "자원 분배 갈등", "한정된 자원을 누구에게 우선 사용할지 결정해야 한다.", "MEDIUM"),
];

export function findEventPreset(id: string | null | undefined): EventPreset | undefined {
  return id ? EVENT_PRESETS.find((p) => p.id === id) : undefined;
}
