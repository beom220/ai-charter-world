import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// 엔진 경계 (CLAUDE.md 절대 규칙 9, architecture.md §5):
// engine·llm·events는 Worker로 분리할 수 있도록 Next.js와 app 계층에 의존하지 않는다.
const engineBoundaryFiles = [
  "src/server/engine/**",
  "src/server/llm/**",
  "src/server/events/**",
];

const engineBoundaryRule = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        {
          name: "next",
          message: "엔진 경계: engine·llm·events는 Next.js에 의존할 수 없습니다.",
        },
      ],
      patterns: [
        {
          group: ["next/*", "@next/*"],
          message: "엔진 경계: engine·llm·events는 Next.js에 의존할 수 없습니다.",
        },
        {
          group: ["@/app", "@/app/*", "**/app/*", "**/src/app/*"],
          message: "엔진 경계: engine·llm·events는 src/app을 import할 수 없습니다.",
        },
      ],
    },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: engineBoundaryFiles,
    rules: engineBoundaryRule,
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
  ]),
]);

export default eslintConfig;
