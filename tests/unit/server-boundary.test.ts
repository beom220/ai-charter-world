import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// architecture.md §5.1 server-only 적용 정책과 경계 규칙
const eslint = new ESLint();
const BOUNDARY_RULES = new Set(["no-restricted-imports", "boundary/no-server-import-in-client"]);

async function boundaryErrors(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId !== null && BOUNDARY_RULES.has(m.ruleId))
    .map((m) => m.message);
}

describe("런타임 독립 서버 모듈", () => {
  const forbidden = [
    'import "server-only";',
    'import "client-only";',
    'import { cookies } from "next/headers";',
    'import { requireUser } from "@/server/auth/session";',
    'import { requireUser } from "../auth/session";',
  ];

  for (const dir of ["db", "domain", "engine", "llm", "events", "crypto", "logging"]) {
    for (const code of forbidden) {
      it(`src/server/${dir}: ${code} → 오류`, async () => {
        const errors = await boundaryErrors(`src/server/${dir}/probe.ts`, `${code}\n`);
        expect(errors).toHaveLength(1);
      });
    }
  }

  it("런타임 독립 모듈끼리는 import할 수 있다", async () => {
    const errors = await boundaryErrors(
      "src/server/engine/probe.ts",
      'import { prisma } from "@/server/db/client";\nimport { x } from "../crypto/x";\n',
    );
    expect(errors).toHaveLength(0);
  });
});

describe("Next.js 전용 서버 어댑터 (src/server/auth)", () => {
  it("server-only와 next/*를 import할 수 있다", async () => {
    const errors = await boundaryErrors(
      "src/server/auth/session.ts",
      'import "server-only";\nimport { headers } from "next/headers";\nimport { prisma } from "@/server/db/client";\n',
    );
    expect(errors).toHaveLength(0);
  });
});

describe("클라이언트 경계", () => {
  const serverImports = [
    'import { prisma } from "@/server/db/client";',
    'import "server-only";',
    'import { PrismaClient } from "@/generated/prisma/client";',
    'export { prisma } from "@/server/db/client";',
    'const m = import("@/server/db/client");',
  ];

  for (const code of [...serverImports, 'import { x } from "../../server/crypto/x";']) {
    it(`"use client" 파일: ${code} → 오류`, async () => {
      const errors = await boundaryErrors(
        "src/app/worlds/client-probe.tsx",
        `"use client";\n${code}\nexport const v = 1;\n`,
      );
      expect(errors).toHaveLength(1);
    });
  }

  for (const code of [...serverImports, 'import { x } from "../server/crypto/x";']) {
    it(`src/lib: ${code} → 오류`, async () => {
      const errors = await boundaryErrors("src/lib/probe.ts", `${code}\nexport const v = 1;\n`);
      expect(errors).toHaveLength(1);
    });
  }

  it("서버 컴포넌트·Route Handler는 src/server를 import할 수 있다", async () => {
    const errors = await boundaryErrors(
      "src/app/api/probe/route.ts",
      'import { prisma } from "@/server/db/client";\nimport { requireUser } from "@/server/auth/session";\n',
    );
    expect(errors).toHaveLength(0);
  });

  it('"use client" 파일도 src/lib는 import할 수 있다', async () => {
    const errors = await boundaryErrors(
      "src/app/worlds/client-probe.tsx",
      '"use client";\nimport { LIMIT } from "@/lib/limits";\nexport const v = LIMIT;\n',
    );
    expect(errors).toHaveLength(0);
  });
});
