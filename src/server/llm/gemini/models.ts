import type { GeminiModelInfo } from "./client";

// 선택 가능 모델 정책 (Phase 3-2). 특정 모델명을 하드코딩하지 않고, API가 알려 준 속성으로 거른다.
// - generateContent를 지원해야 한다 (대화 생성에 필요)
// - Gemini 계열(ID가 "gemini-"로 시작)만 쓴다. Gemma·Imagen·Veo 등 다른 계열은 제외
// - 텍스트 대화가 아닌 특수 목적 변형(음성 합성·이미지 생성·실시간 오디오·임베딩)은 제외

const SPECIAL_PURPOSE = /(?:^|-)(tts|image|audio|live|embedding)(?:-|$)/;

export function isSelectableGeminiModel(model: GeminiModelInfo): boolean {
  return model.supportedActions.includes("generateContent") && model.id.startsWith("gemini-") && !SPECIAL_PURPOSE.test(model.id);
}

/** 미리보기·실험 모델 여부 (UI 표시용, 선택은 허용) */
export function isPreviewGeminiModel(model: GeminiModelInfo): boolean {
  return /(?:^|-)(preview|exp|experimental)(?:-|$)/.test(model.id);
}

export type SelectableModel = GeminiModelInfo & { preview: boolean };

export function selectableModels(models: GeminiModelInfo[]): SelectableModel[] {
  return models
    .filter(isSelectableGeminiModel)
    .map((m) => ({ ...m, preview: isPreviewGeminiModel(m) }))
    .sort((a, b) => Number(a.preview) - Number(b.preview) || a.id.localeCompare(b.id));
}
