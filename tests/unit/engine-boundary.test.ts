import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// CLAUDE.md 절대 규칙 9: engine·llm·events는 next/*·src/app을 import하지 않는다.
const eslint = new ESLint();

async function restrictedImportErrors(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message);
}

describe("엔진 경계 린트 규칙", () => {
  const forbidden = [
    'import { headers } from "next/headers";',
    'import Next from "next";',
    'import page from "@/app/page";',
    'import page from "../../app/page";',
  ];

  for (const dir of ["engine", "llm", "events"]) {
    for (const code of forbidden) {
      it(`src/server/${dir}: ${code} → 오류`, async () => {
        const errors = await restrictedImportErrors(`src/server/${dir}/probe.ts`, `${code}\n`);
        expect(errors).toHaveLength(1);
      });
    }
  }

  it("경계 밖(src/server/domain)에서는 next/* import를 막지 않는다", async () => {
    const errors = await restrictedImportErrors(
      "src/server/domain/probe.ts",
      'import { headers } from "next/headers";\n',
    );
    expect(errors).toHaveLength(0);
  });
});
