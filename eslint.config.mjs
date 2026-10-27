import path from "node:path";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// 서버 경계 정책 (CLAUDE.md 절대 규칙 9, architecture.md §5.1):
// - Next.js 전용 서버 어댑터(src/server/auth)만 Next.js와 server-only에 의존한다.
// - 나머지 src/server 모듈은 Worker에서도 쓸 수 있도록 실행 환경에 독립적으로 둔다.
// - 클라이언트 코드("use client" 파일, src/lib)는 src/server와 생성된 Prisma Client를 import할 수 없다.

const nextAdapterFiles = ["src/server/auth/**"];

const runtimeIndependentRule = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        {
          name: "next",
          message: "런타임 독립 경계: Next.js에 의존할 수 없습니다. Next.js 전용 코드는 src/server/auth 또는 src/app에 둡니다.",
        },
        {
          name: "server-only",
          message: "런타임 독립 경계: Worker에서 import할 수 없으므로 server-only를 쓰지 않습니다.",
        },
        {
          name: "client-only",
          message: "런타임 독립 경계: 서버 모듈은 client-only를 import할 수 없습니다.",
        },
      ],
      patterns: [
        {
          group: ["next/*", "@next/*"],
          message: "런타임 독립 경계: Next.js에 의존할 수 없습니다. Next.js 전용 코드는 src/server/auth 또는 src/app에 둡니다.",
        },
        {
          group: ["@/app", "@/app/*", "**/app/*", "**/src/app/*"],
          message: "런타임 독립 경계: src/app을 import할 수 없습니다.",
        },
        {
          group: ["@/server/auth", "@/server/auth/*", "**/server/auth", "**/server/auth/*", "../auth", "../auth/*"],
          message: "런타임 독립 경계: Next.js 전용 어댑터(src/server/auth)를 import할 수 없습니다.",
        },
      ],
    },
  ],
};

const srcRoot = path.resolve(import.meta.dirname, "src");
const clientForbiddenDirs = ["server", "generated"].map((d) => path.join(srcRoot, d));

function isServerSpecifier(specifier, filename) {
  if (specifier === "server-only") return true;
  if (/^@\/(server|generated)(\/|$)/.test(specifier)) return true;
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(filename), specifier);
    return clientForbiddenDirs.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep));
  }
  return false;
}

const noServerImportInClient = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: { always: { type: "boolean" } },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden:
        "클라이언트 경계: '{{source}}'는 서버 전용 모듈입니다. \"use client\" 파일과 src/lib에서는 src/server·Prisma Client·server-only를 import할 수 없습니다.",
    },
  },
  create(context) {
    const always = context.options[0]?.always === true;
    const isClientFile = context.sourceCode.ast.body.some(
      (node) => node.type === "ExpressionStatement" && node.directive === "use client",
    );
    if (!always && !isClientFile) return {};

    const check = (sourceNode) => {
      if (sourceNode?.type !== "Literal" || typeof sourceNode.value !== "string") return;
      if (isServerSpecifier(sourceNode.value, context.filename)) {
        context.report({ node: sourceNode, messageId: "forbidden", data: { source: sourceNode.value } });
      }
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
    };
  },
};

const boundaryPlugin = {
  rules: { "no-server-import-in-client": noServerImportInClient },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: { boundary: boundaryPlugin },
    files: ["src/**/*.{js,jsx,ts,tsx,mjs}"],
    rules: { "boundary/no-server-import-in-client": "error" },
  },
  {
    files: ["src/lib/**"],
    rules: { "boundary/no-server-import-in-client": ["error", { always: true }] },
  },
  {
    files: ["src/server/**"],
    ignores: nextAdapterFiles,
    rules: runtimeIndependentRule,
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
