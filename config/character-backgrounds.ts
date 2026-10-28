// 캐릭터 유년기·성년기 배경 고정 프리셋 44종 (Phase 7-1 명세 §3). 클라이언트·서버 공용 단일 소스.
// - DB와 세이브에는 ID만 저장하고 이름·설명은 여기서 찾는다. 항목을 임의로 바꾸거나 더하지 않는다.
// - 유년기는 모든 캐릭터 필수, 성년기는 19세 이상 필수·18세 이하 설정 불가. 사용자 직접 입력·"미설정" 선택지는 없다.
// - 배경은 과거 경험일 뿐 현재 성격·능력을 정하는 스탯이 아니다.
// - 랜덤: 등급을 먼저 가중 추첨(일반 60%·특수 30%·희귀 10%)한 뒤 그 등급 안에서 균등 선택한다.

export type BackgroundStage = "CHILDHOOD" | "ADULTHOOD";
export type BackgroundRarity = "COMMON" | "UNCOMMON" | "RARE";
export type BackgroundPreset = { id: string; name: string; description: string; rarity: BackgroundRarity; stage: BackgroundStage };

/** 성년기 배경을 가질 수 있는(그리고 반드시 가져야 하는) 최소 나이 */
export const ADULTHOOD_MIN_AGE = 19;

export const BACKGROUND_RARITIES = ["COMMON", "UNCOMMON", "RARE"] as const satisfies readonly BackgroundRarity[];
export const BACKGROUND_RARITY_LABEL: Record<BackgroundRarity, string> = { COMMON: "일반", UNCOMMON: "특수", RARE: "희귀" };
export const BACKGROUND_STAGE_LABEL: Record<BackgroundStage, string> = { CHILDHOOD: "유년기", ADULTHOOD: "성년기" };

/** 등급 추첨 가중치 (합 1) */
export const BACKGROUND_RARITY_WEIGHTS: Record<BackgroundRarity, number> = { COMMON: 0.6, UNCOMMON: 0.3, RARE: 0.1 };

const C = (id: string, name: string, description: string, rarity: BackgroundRarity): BackgroundPreset => ({ id, name, description, rarity, stage: "CHILDHOOD" });
const A = (id: string, name: string, description: string, rarity: BackgroundRarity): BackgroundPreset => ({ id, name, description, rarity, stage: "ADULTHOOD" });

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  // 유년기 — COMMON (8)
  C("childhood_farm", "시골 농가의 아이", "농사와 가축을 돌보며 자연 속에서 성장했다.", "COMMON"),
  C("childhood_city", "도시의 평범한 아이", "도시 가정에서 학교와 이웃을 경험하며 자랐다.", "COMMON"),
  C("childhood_fishing", "어촌의 아이", "바다와 배에 익숙한 환경에서 성장했다.", "COMMON"),
  C("childhood_merchant", "상인의 자식", "부모의 장사를 도우며 거래와 사람을 상대하는 법을 배웠다.", "COMMON"),
  C("childhood_craftsman", "기술자의 자식", "작업장에서 도구와 기계를 접하며 성장했다.", "COMMON"),
  C("childhood_military_family", "군인 가정의 아이", "엄격한 규율과 잦은 이사 속에서 성장했다.", "COMMON"),
  C("childhood_bookworm", "책벌레", "책을 읽고 지식을 탐구하는 데 많은 시간을 보냈다.", "COMMON"),
  C("childhood_athlete", "운동선수 지망생", "어린 시절부터 경쟁과 훈련에 많은 시간을 보냈다.", "COMMON"),
  // 유년기 — UNCOMMON (8)
  C("childhood_street_urchin", "도시의 부랑아", "거리에서 구걸과 잔심부름으로 살아남았다.", "UNCOMMON"),
  C("childhood_war_orphan", "전쟁 고아", "전쟁으로 가족을 잃고 불안정한 환경에서 성장했다.", "UNCOMMON"),
  C("childhood_fallen_noble", "몰락한 귀족의 자식", "부유한 가문에서 태어났지만 몰락을 경험했다.", "UNCOMMON"),
  C("childhood_troupe", "떠돌이 극단의 아이", "공연단과 여행하며 연기와 표현을 배웠다.", "UNCOMMON"),
  C("childhood_hermit_apprentice", "산속 은둔자의 제자", "외딴 산속에서 스승에게 생존 지식과 기술을 배웠다.", "UNCOMMON"),
  C("childhood_pirate", "해적선의 꼬마", "선원들과 항해하며 거친 세상을 경험했다.", "UNCOMMON"),
  C("childhood_disaster", "재앙의 생존자", "대형 재난에서 살아남아 새로운 삶을 시작했다.", "UNCOMMON"),
  C("childhood_gang_errand", "범죄 조직의 심부름꾼", "어린 시절 범죄 조직 주변에서 잡일을 하며 성장했다.", "UNCOMMON"),
  // 유년기 — RARE (4)
  C("childhood_test_subject", "비밀 실험체", "정체불명의 연구시설에서 실험 대상으로 성장했다.", "RARE"),
  C("childhood_feral", "야생에서 자란 아이", "문명과 단절된 채 야생에서 성장했다.", "RARE"),
  C("childhood_assassin", "암살자 양성소 출신", "어린 시절부터 은밀한 행동과 전투 기술을 교육받았다.", "RARE"),
  C("childhood_clone", "복제 인간 프로젝트 출신", "자신의 출생에 관한 비밀을 품고 성장했다.", "RARE"),
  // 성년기 — COMMON (10)
  A("adulthood_farmer", "농부", "작물을 재배하고 가축을 돌보며 살아왔다.", "COMMON"),
  A("adulthood_doctor", "의사", "환자를 진료하고 질병과 부상을 치료했다.", "COMMON"),
  A("adulthood_scientist", "과학자", "연구와 실험으로 새로운 지식을 탐구했다.", "COMMON"),
  A("adulthood_engineer", "기술자", "기계와 장비를 설계하거나 수리했다.", "COMMON"),
  A("adulthood_chef", "요리사", "다양한 식재료를 다루고 음식을 만들었다.", "COMMON"),
  A("adulthood_teacher", "교사", "학생들을 가르치고 지식을 전달했다.", "COMMON"),
  A("adulthood_merchant", "상인", "물건을 사고팔며 거래와 협상을 경험했다.", "COMMON"),
  A("adulthood_soldier", "군인", "군사 훈련을 받고 조직 생활을 경험했다.", "COMMON"),
  A("adulthood_artist", "예술가", "그림·음악·공연 등 창작 활동을 해왔다.", "COMMON"),
  A("adulthood_hunter", "사냥꾼", "야생동물을 추적하고 사냥하며 살아왔다.", "COMMON"),
  // 성년기 — UNCOMMON (9)
  A("adulthood_field_medic", "전장의 야전의사", "장비가 부족한 전장에서 부상자들을 치료했다.", "UNCOMMON"),
  A("adulthood_wasteland_engineer", "황무지의 기술자", "폐허에서 고철을 모아 장비를 수리했다.", "UNCOMMON"),
  A("adulthood_bounty_hunter", "현상금 사냥꾼", "보상을 받고 위험한 인물을 추적했다.", "UNCOMMON"),
  A("adulthood_deserter", "부대를 버린 탈영병", "전장에서 부대를 이탈한 과거가 있다.", "UNCOMMON"),
  A("adulthood_black_market", "암시장 상인", "비공식적인 거래망으로 물건을 거래했다.", "UNCOMMON"),
  A("adulthood_wanderer", "떠돌이 탐험가", "정착하지 않고 여러 지역을 탐험했다.", "UNCOMMON"),
  A("adulthood_failed_business", "몰락한 사업가", "한때 사업을 운영했지만 모든 것을 잃었다.", "UNCOMMON"),
  A("adulthood_rescuer", "재난 구조대원", "위험한 재난 현장에서 사람들을 구조했다.", "UNCOMMON"),
  A("adulthood_con_artist", "전설적인 사기꾼", "뛰어난 언변과 속임수로 사람들을 현혹했다.", "UNCOMMON"),
  // 성년기 — RARE (5)
  A("adulthood_forbidden_researcher", "금지된 실험의 연구원", "윤리적으로 문제가 있는 비밀 연구에 참여했다.", "RARE"),
  A("adulthood_exiled_royal", "추방된 왕족", "권력 다툼에서 패배하고 신분을 잃었다.", "RARE"),
  A("adulthood_royal_assassin", "왕실 암살자", "권력자의 명령으로 은밀한 임무를 수행했다.", "RARE"),
  A("adulthood_memory_expert", "기억 조작 전문가", "타인의 기억을 수정하는 특수 기술을 다뤘다.", "RARE"),
  A("adulthood_dimension_explorer", "차원 탐험가", "다른 차원을 탐험하고 돌아온 경험이 있다.", "RARE"),
];

const BY_ID = new Map(BACKGROUND_PRESETS.map((p) => [p.id, p]));

export const CHILDHOOD_BACKGROUND_IDS = BACKGROUND_PRESETS.filter((p) => p.stage === "CHILDHOOD").map((p) => p.id);
export const ADULTHOOD_BACKGROUND_IDS = BACKGROUND_PRESETS.filter((p) => p.stage === "ADULTHOOD").map((p) => p.id);

/** ID → 프리셋. 단계가 주어지면 그 단계의 ID만 찾는다. 없으면 null */
export function findBackground(id: string | null | undefined, stage?: BackgroundStage): BackgroundPreset | null {
  const preset = id ? BY_ID.get(id) : undefined;
  return preset && (!stage || preset.stage === stage) ? preset : null;
}

export const backgroundsOf = (stage: BackgroundStage, rarity?: BackgroundRarity) =>
  BACKGROUND_PRESETS.filter((p) => p.stage === stage && (!rarity || p.rarity === rarity));

/** 성년기 배경이 필요한(그리고 허용되는) 나이인가 */
export const requiresAdulthood = (age: number) => age >= ADULTHOOD_MIN_AGE;

/** 등급 가중 추첨 → 등급 안 균등 선택. rng는 [0,1) */
export function pickRandomBackground(stage: BackgroundStage, rng: () => number = Math.random): BackgroundPreset {
  const r = rng();
  let acc = 0;
  let rarity: BackgroundRarity = "RARE";
  for (const candidate of BACKGROUND_RARITIES) {
    acc += BACKGROUND_RARITY_WEIGHTS[candidate];
    if (r < acc) {
      rarity = candidate;
      break;
    }
  }
  const pool = backgroundsOf(stage, rarity);
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;
}
