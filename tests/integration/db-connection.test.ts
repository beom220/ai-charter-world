import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/client";

describe("Prisma DB 연결", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("PostgreSQL에 SELECT 1을 실행한다", async () => {
    const rows = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1::int AS ok`;
    expect(rows).toEqual([{ ok: 1 }]);
  });

  it("DB 세션 시간대가 UTC다", async () => {
    const rows = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(rows[0]?.tz).toBe("UTC");
  });
});
