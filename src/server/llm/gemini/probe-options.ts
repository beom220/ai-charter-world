import { ThinkingLevel, type GenerateContentConfig } from "@google/genai";

// 모델 확인(probe) 요청의 모델별 사고 수준 (Phase 3-2 승인).
// 범용 모델 설정 시스템이 아니다. 공식 문서와 SDK 타입으로 지원이 확인된 모델만 명시하고,
// 목록에 없는 모델은 사고 설정을 보내지 않는다(모델 기본값). 잘못된 값은 400을 일으킬 수 있기 때문이다.
//
// 근거: https://ai.google.dev/gemini-api/docs/thinking (2026-10-27 확인)
//   - gemini-3.8-flash: 기본 medium, low·medium·high 지원 (minimal 미지원)
// SDK(@google/genai 2.31.0): GenerateContentConfig.thinkingConfig.thinkingLevel (ThinkingLevel.LOW = "LOW")
const PROBE_THINKING_LEVEL: Readonly<Record<string, ThinkingLevel>> = {
  "gemini-3.8-flash": ThinkingLevel.LOW,
};

export function probeThinkingConfig(modelId: string): Pick<GenerateContentConfig, "thinkingConfig"> {
  const level = PROBE_THINKING_LEVEL[modelId];
  return level ? { thinkingConfig: { thinkingLevel: level } } : {};
}
