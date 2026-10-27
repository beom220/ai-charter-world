import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { BREAKER_BACKOFF_BASE_MS, BREAKER_TRANSIENT_FAILURE_THRESHOLD, PROVIDER_CHECK_RATE_LIMIT, USAGE_PENDING_STALE_MS } from "../../config/limits";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { selectGeminiModel, verifyGeminiConnection } from "@/server/domain/providers/gemini-verification";
import { BLOCK_REASON } from "@/server/engine/usage/breaker";
import { CircuitOpenError, ConnectionNotReadyError, KeyChangedError, ProviderRateLimitError, UsageLimitError } from "@/server/engine/usage/errors";
import { kstDate } from "@/server/engine/usage/kst";
import { createUsageMeter, type UsagePurpose } from "@/server/engine/usage/usage-guard";
import type { GeminiCallRecord } from "@/server/llm/gemini/client";
import { createMockGeminiClient, type MockGeminiScript } from "@/server/llm/mock/gemini-mock";
import { cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// Phase 3-3 UsageGuard: 사용량 기록·연결별 일일 한도(KST)·원자적 예약·백오프·서킷 브레이커 (실제 DB + Mock Gemini)
const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "usage-guard-fingerprint-secret-0123456789",
});

const MODEL = "gemini-mock-flash";
const T0 = new Date("2026-10-28T03:00:00.000Z"); // KST 12:00

type Limits = { dailyRequestLimit?: number | null; dailyTokenLimit?: number | null };

/** 사용자 + 검증된(ACTIVE) 연결 + 세계관 */
async function setup(label: string, limits: Limits = {}) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  const apiKey = fakeGeminiKey(label);
  await saveGeminiApiKey(uid, apiKey, material);
  const conn = await prisma.aiProviderConnection.update({
    where: { userId_provider: { userId: user.id, provider: "GEMINI" } },
    data: { status: "ACTIVE", defaultModel: MODEL, ...limits },
  });
  const world = await createTestWorld(user.id);
  const target = { userId: user.id, connectionId: conn.id, keyFingerprint: conn.keyFingerprint };
  return { user, uid, apiKey, conn, world, target };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** 시뮬레이션 경로의 생성 요청 1건 (엔진이 쓸 방식과 같음: 요청마다 meter → 클라이언트) */
function simCall(ctx: Ctx, script: MockGeminiScript | ReturnType<typeof createMockGeminiClient>, now: Date = T0, purpose: Partial<Extract<UsagePurpose, { kind: "SIMULATION" }>> = {}) {
  const mock = "client" in script ? script : createMockGeminiClient(script);
  const meter = createUsageMeter(ctx.target, { kind: "SIMULATION", worldId: ctx.world.id, ...purpose }, { now: () => now });
  return { mock, result: mock.client.probeModel(ctx.apiKey, MODEL, meter) };
}

async function runSim(ctx: Ctx, script: MockGeminiScript | ReturnType<typeof createMockGeminiClient> = {}, now: Date = T0, purpose = {}) {
  const { mock, result } = simCall(ctx, script, now, purpose);
  const value = await result.catch((e: unknown) => e);
  return { mock, value };
}

const daily = (connectionId: string, at: Date = T0) =>
  prisma.apiUsageDaily.findUnique({ where: { connectionId_usageDate: { connectionId, usageDate: kstDate(at) } } });
const logs = (userId: string) => prisma.apiRequestLog.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
const connection = (id: string) => prisma.aiProviderConnection.findUniqueOrThrow({ where: { id } });
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

/** 일일 집계 = 호출 기록 집계 (KST 날짜별) */
async function expectDailyMatchesLogs(connectionId: string) {
  const rows = await prisma.apiRequestLog.findMany({ where: { connectionId } });
  const expected = new Map<string, { requestCount: number; inputTokens: number; outputTokens: number; thoughtTokens: number; unmeteredRequestCount: number }>();
  for (const r of rows) {
    const key = kstDate(r.createdAt).toISOString();
    const e = expected.get(key) ?? { requestCount: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, unmeteredRequestCount: 0 };
    e.requestCount += 1;
    e.inputTokens += r.inputTokens ?? 0;
    e.outputTokens += r.outputTokens ?? 0;
    e.thoughtTokens += r.thoughtTokens ?? 0;
    e.unmeteredRequestCount += r.usageStatus === "MISSING" || r.usageStatus === "UNKNOWN" ? 1 : 0;
    expected.set(key, e);
  }
  const actual = await prisma.apiUsageDaily.findMany({ where: { connectionId } });
  const actualMap = new Map(
    actual
      .filter((a) => a.requestCount > 0)
      .map((a) => [a.usageDate.toISOString(), { requestCount: a.requestCount, inputTokens: a.inputTokens, outputTokens: a.outputTokens, thoughtTokens: a.thoughtTokens, unmeteredRequestCount: a.unmeteredRequestCount }]),
  );
  expect(actualMap).toEqual(expected);
}

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("사용량 기록", () => {
  it("성공한 생성 요청: 로그 SUCCESS·REPORTED·토큰, 일일 집계에 요청 1·토큰 누적", async () => {
    const ctx = await setup("rec-ok");
    const { mock, value } = await runSim(ctx, { probeUsage: { inputTokens: 7, outputTokens: 3, thoughtTokens: 11 } });
    expect(value).toEqual({ inputTokens: 7, outputTokens: 3, thoughtTokens: 11 });
    expect(mock.calls).toHaveLength(1);
    expect(await logs(ctx.user.id)).toMatchObject([
      { outcome: "SUCCESS", httpStatus: 200, usageStatus: "REPORTED", inputTokens: 7, outputTokens: 3, thoughtTokens: 11, worldId: ctx.world.id, connectionId: ctx.conn.id, createdAt: T0 },
    ]);
    expect(await daily(ctx.conn.id)).toMatchObject({ requestCount: 1, inputTokens: 7, outputTokens: 3, thoughtTokens: 11, unmeteredRequestCount: 0 });
  });

  it("실패한 요청도 기록한다: 5xx → UNKNOWN(과금 여부 불명, 미계측 +1), 429 → NOT_APPLICABLE", async () => {
    const ctx = await setup("rec-fail");
    await runSim(ctx, { failProbe: { [MODEL]: "UPSTREAM_ERROR" } });
    await runSim(ctx, { failProbe: { [MODEL]: "TIMEOUT" } }, plus(T0, 1));
    const later = plus(T0, 10 * 60 * 1000); // 백오프 이후
    await prisma.aiProviderConnection.update({ where: { id: ctx.conn.id }, data: { consecutiveFailures: 0, backoffLevel: 0, blockedUntil: null, blockReason: null } });
    await runSim(ctx, { failProbe: { [MODEL]: "QUOTA_EXCEEDED" } }, later);

    expect(await logs(ctx.user.id)).toMatchObject([
      { outcome: "HTTP_ERROR", httpStatus: 503, errorCode: "UPSTREAM_ERROR", usageStatus: "UNKNOWN", inputTokens: null },
      { outcome: "NETWORK_ERROR", httpStatus: null, errorCode: "TIMEOUT", usageStatus: "UNKNOWN" },
      { outcome: "HTTP_ERROR", httpStatus: 429, errorCode: "QUOTA_EXCEEDED", usageStatus: "NOT_APPLICABLE" },
    ]);
    expect(await daily(ctx.conn.id)).toMatchObject({ requestCount: 3, inputTokens: 0, unmeteredRequestCount: 2 });
    await expectDailyMatchesLogs(ctx.conn.id);
  });

  it("사용량 미반환 응답(200, usageMetadata 없음): 토큰을 0으로 단정하지 않고 MISSING, 토큰 null, 미계측 +1", async () => {
    const ctx = await setup("rec-missing");
    const { value } = await runSim(ctx, { probeUsage: null });
    expect(value).toBeNull();
    expect(await logs(ctx.user.id)).toMatchObject([{ outcome: "SUCCESS", usageStatus: "MISSING", inputTokens: null, outputTokens: null, thoughtTokens: null }]);
    expect(await daily(ctx.conn.id)).toMatchObject({ requestCount: 1, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, unmeteredRequestCount: 1 });
  });

  it("연결 관리용 호출(검증·모델 확인 probe)도 일일 집계에 포함된다 — probe 토큰 포함", async () => {
    const ctx = await setup("rec-mgmt");
    const mock = createMockGeminiClient();
    await verifyGeminiConnection(ctx.uid, { client: mock.client, material, now: () => T0 });
    await selectGeminiModel(ctx.uid, MODEL, { client: mock.client, material, now: () => plus(T0, 1) });
    expect(await logs(ctx.user.id)).toMatchObject([
      { model: "(models.list)", outcome: "SUCCESS", usageStatus: "NOT_APPLICABLE", worldId: null },
      { model: MODEL, outcome: "SUCCESS", usageStatus: "NOT_APPLICABLE" }, // models.get
      { model: MODEL, outcome: "SUCCESS", usageStatus: "REPORTED", inputTokens: 1, outputTokens: 1 }, // probe
    ]);
    expect(await daily(ctx.conn.id)).toMatchObject({ requestCount: 3, inputTokens: 1, outputTokens: 1 });
    await expectDailyMatchesLogs(ctx.conn.id);
  });

  it("Run(세션)별 사용량을 키 단위 집계와 별도로 누적한다", async () => {
    const ctx = await setup("rec-run");
    const run = await prisma.simulationRun.create({ data: { worldId: ctx.world.id } });
    await runSim(ctx, { probeUsage: { inputTokens: 5, outputTokens: 2, thoughtTokens: 1 } }, T0, { runId: run.id, attemptId: "a1" });
    await runSim(ctx, { failProbe: { [MODEL]: "UPSTREAM_ERROR" } }, plus(T0, 1), { runId: run.id, attemptId: "a2" });
    expect(await prisma.simulationRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      requestCount: 2,
      successCount: 1,
      failureCount: 1,
      inputTokens: 5,
      outputTokens: 2,
      thoughtTokens: 1,
    });
    expect((await logs(ctx.user.id)).map((l) => [l.runId, l.attemptId])).toEqual([
      [run.id, "a1"],
      [run.id, "a2"],
    ]);
  });

  it("로컬에서 거부되어 전송되지 않은 시도는 예약을 되돌린다 (요청 수·로그 0)", async () => {
    const ctx = await setup("rec-local");
    const meter = createUsageMeter(ctx.target, { kind: "SIMULATION", worldId: ctx.world.id }, { now: () => T0 });
    const settle = await meter({ operation: "models.generateContent", model: MODEL });
    expect(await logs(ctx.user.id)).toMatchObject([{ outcome: "PENDING" }]);
    expect(await daily(ctx.conn.id)).toMatchObject({ requestCount: 1 });

    const record: GeminiCallRecord = { operation: "models.generateContent", model: MODEL, startedAt: T0, latencyMs: 0, httpStatus: null, errorKind: "KEY_INVALID", upstreamDetail: "local=HEADER_VALUE_REJECTED", usage: null, retryAfterMs: null, sent: false };
    await settle(record);
    expect(await logs(ctx.user.id)).toHaveLength(0);
    expect(await daily(ctx.conn.id)).toMatchObject({ requestCount: 0 });
  });

  it("예약 후 정산되지 않은 호출(프로세스 종료 등)은 다음 예약 때 결과 유실(UNKNOWN)로 확정한다", async () => {
    const ctx = await setup("rec-lost");
    const meter = createUsageMeter(ctx.target, { kind: "SIMULATION", worldId: ctx.world.id }, { now: () => T0 });
    await meter({ operation: "models.generateContent", model: MODEL }); // 정산하지 않음

    // 아직 오래되지 않았으면 그대로 둔다
    await runSim(ctx, {}, plus(T0, 1000));
    expect((await logs(ctx.user.id))[0]).toMatchObject({ outcome: "PENDING" });

    await runSim(ctx, {}, plus(T0, USAGE_PENDING_STALE_MS + 1));
    const all = await logs(ctx.user.id);
    expect(all[0]).toMatchObject({ outcome: "ABORTED", errorCode: "RESULT_LOST", usageStatus: "UNKNOWN" });
    expect(all.filter((l) => l.outcome === "PENDING")).toHaveLength(0);
    expect(await daily(ctx.conn.id)).toMatchObject({ requestCount: 3, unmeteredRequestCount: 1 });
    await expectDailyMatchesLogs(ctx.conn.id);
  });
});

describe("연결별 일일 한도 (KST)", () => {
  it("요청 한도 도달: 한도만큼만 전송하고 다음 요청은 전송 전에 차단(USAGE_LIMIT_REACHED, 다음 KST 자정)", async () => {
    const ctx = await setup("lim-req", { dailyRequestLimit: 3 });
    const mock = createMockGeminiClient();
    for (let i = 0; i < 3; i++) expect((await runSim(ctx, mock, plus(T0, i))).value).not.toBeInstanceOf(Error);
    const { value } = await runSim(ctx, mock, plus(T0, 3));

    expect(value).toBeInstanceOf(UsageLimitError);
    expect(value).toMatchObject({ limit: "REQUESTS", status: 429, code: "USAGE_LIMIT_REACHED", resetsAt: new Date("2026-10-28T15:00:00.000Z") });
    expect((value as UsageLimitError).retryAfterSeconds).toBe(12 * 3600); // KST 12:00 → 자정까지 12시간
    expect(mock.calls).toHaveLength(3);
    expect(await logs(ctx.user.id)).toHaveLength(3);
    expect(await daily(ctx.conn.id)).toMatchObject({ requestCount: 3 });
  });

  it("토큰 한도 도달: 누적 토큰이 한도에 닿으면 다음 생성 요청부터 차단, 토큰을 쓰지 않는 요청은 요청 한도만 적용", async () => {
    const ctx = await setup("lim-tok", { dailyTokenLimit: 10 });
    const mock = createMockGeminiClient({ probeUsage: { inputTokens: 4, outputTokens: 3, thoughtTokens: 2 } }); // 9
    await runSim(ctx, mock);
    await runSim(ctx, mock, plus(T0, 1)); // 9 < 10 → 허용, 누적 18 (진행 중이던 요청만큼 초과 가능)
    const { value } = await runSim(ctx, mock, plus(T0, 2));
    expect(value).toBeInstanceOf(UsageLimitError);
    expect(value).toMatchObject({ limit: "TOKENS" });
    expect(mock.calls).toHaveLength(2);
    expect(await daily(ctx.conn.id)).toMatchObject({ requestCount: 2, inputTokens: 8, outputTokens: 6, thoughtTokens: 4 });

    // 키 검증(models.list)은 토큰을 쓰지 않으므로 토큰 한도로 막지 않는다
    await expect(verifyGeminiConnection(ctx.uid, { client: createMockGeminiClient().client, material, now: () => plus(T0, 3) })).resolves.toMatchObject({ verification: { ok: true } });
  });

  it("연결 관리용 호출도 일일 요청 한도를 넘지 못한다 (외부 호출 없이 429 USAGE_LIMIT_REACHED)", async () => {
    const ctx = await setup("lim-mgmt", { dailyRequestLimit: 1 });
    const mock = createMockGeminiClient();
    await verifyGeminiConnection(ctx.uid, { client: mock.client, material, now: () => T0 });
    await expect(verifyGeminiConnection(ctx.uid, { client: mock.client, material, now: () => plus(T0, 1) })).rejects.toBeInstanceOf(UsageLimitError);
    expect(mock.calls).toHaveLength(1);
  });

  it("KST 자정 경계: 23:59:59.999(KST)까지는 같은 날 한도, 00:00(KST)부터 새 날짜로 집계", async () => {
    const ctx = await setup("lim-midnight", { dailyRequestLimit: 1 });
    const mock = createMockGeminiClient();
    const lastMs = new Date("2026-10-28T14:59:59.999Z"); // KST 10-28 23:59:59.999
    const midnight = new Date("2026-10-28T15:00:00.000Z"); // KST 10-29 00:00

    await runSim(ctx, mock, new Date("2026-10-28T14:00:00Z"));
    expect((await runSim(ctx, mock, lastMs)).value).toBeInstanceOf(UsageLimitError);
    expect((await runSim(ctx, mock, midnight)).value).not.toBeInstanceOf(Error);

    const rows = await prisma.apiUsageDaily.findMany({ where: { connectionId: ctx.conn.id }, orderBy: { usageDate: "asc" } });
    expect(rows.map((r) => [r.usageDate.toISOString().slice(0, 10), r.requestCount])).toEqual([
      ["2026-10-28", 1],
      ["2026-10-29", 1],
    ]);
    // 저장 시각은 UTC 그대로
    expect((await logs(ctx.user.id)).map((l) => l.createdAt.toISOString())).toEqual(["2026-10-28T14:00:00.000Z", "2026-10-28T15:00:00.000Z"]);
  });

  it("자정 직전에 예약한 요청은 자정 이후에 응답이 와도 예약한 날짜에 정산한다", async () => {
    const ctx = await setup("lim-straddle");
    const before = new Date("2026-10-28T14:59:59.900Z");
    const after = new Date("2026-10-28T15:00:00.500Z");
    let tick = 0;
    const meter = createUsageMeter(ctx.target, { kind: "SIMULATION", worldId: ctx.world.id }, { now: () => (tick++ === 0 ? before : after) });
    await createMockGeminiClient({ probeUsage: { inputTokens: 3, outputTokens: 2, thoughtTokens: 0 } }).client.probeModel(ctx.apiKey, MODEL, meter);

    expect(await daily(ctx.conn.id, before)).toMatchObject({ requestCount: 1, inputTokens: 3, outputTokens: 2 });
    expect(await daily(ctx.conn.id, after)).toBeNull();
  });

  it("API 키를 교체해도 한도 설정과 사용량 집계는 유지되고, 백오프만 초기화된다", async () => {
    const ctx = await setup("lim-rotate", { dailyRequestLimit: 3, dailyTokenLimit: 1000 });
    await runSim(ctx, { probeUsage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 } });
    await runSim(ctx, { failProbe: { [MODEL]: "QUOTA_EXCEEDED" } }, plus(T0, 1)); // 브레이커 열림
    expect(await connection(ctx.conn.id)).toMatchObject({ backoffLevel: 1, blockReason: BLOCK_REASON.RATE_LIMITED });

    await saveGeminiApiKey(ctx.uid, fakeGeminiKey("lim-rotate-new"), material);
    const rotated = await connection(ctx.conn.id);
    expect(rotated).toMatchObject({ dailyRequestLimit: 3, dailyTokenLimit: 1000, consecutiveFailures: 0, backoffLevel: 0, blockedUntil: null, blockReason: null, status: "UNVERIFIED" });
    expect(await daily(ctx.conn.id)).toMatchObject({ requestCount: 2, inputTokens: 1 });

    // 새 키를 검증(3번째 요청)하면 오늘 한도(3)에 닿는다 — 집계가 키 교체로 초기화되지 않았음
    const mock = createMockGeminiClient();
    await verifyGeminiConnection(ctx.uid, { client: mock.client, material, now: () => plus(T0, 2) });
    const next = { ...ctx, target: { ...ctx.target, keyFingerprint: rotated.keyFingerprint } };
    expect((await runSim(next, mock, plus(T0, 3))).value).toBeInstanceOf(UsageLimitError);
    expect(mock.calls).toHaveLength(1);
  });

  it("예약 시점에 키가 바뀌어 있으면 이전 키로 요청하지 않는다 (KEY_CHANGED)", async () => {
    const ctx = await setup("lim-keychg");
    await saveGeminiApiKey(ctx.uid, fakeGeminiKey("lim-keychg-new"), material);
    const { mock, value } = await runSim(ctx, {});
    expect(value).toBeInstanceOf(KeyChangedError);
    expect(mock.calls).toHaveLength(0);
    expect(await logs(ctx.user.id)).toHaveLength(0);
  });
});

describe("동시성 (DB 행 잠금 기반 원자적 예약)", () => {
  it("요청 한도 5에 동시 생성 요청 20건 → 정확히 5건만 전송, 15건은 전송 전 차단", async () => {
    const ctx = await setup("con-daily", { dailyRequestLimit: 5 });
    const mock = createMockGeminiClient({ delayMs: 30 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => simCall(ctx, mock, plus(T0, i)).result.catch((e: unknown) => e)));

    expect(results.filter((r) => r instanceof UsageLimitError)).toHaveLength(15);
    expect(mock.calls).toHaveLength(5);
    expect(await logs(ctx.user.id)).toHaveLength(5);
    expect(await daily(ctx.conn.id)).toMatchObject({ requestCount: 5 });
    await expectDailyMatchesLogs(ctx.conn.id);
  });

  it(`연결 관리용 호출 한도(${PROVIDER_CHECK_RATE_LIMIT.maxCalls}회/10분)도 동시 요청 ${PROVIDER_CHECK_RATE_LIMIT.maxCalls + 6}건에 정확히 지켜진다 (Phase 3-2 알려진 한계 해결)`, async () => {
    const ctx = await setup("con-mgmt");
    const mock = createMockGeminiClient({ delayMs: 30 });
    const n = PROVIDER_CHECK_RATE_LIMIT.maxCalls + 6;
    const results = await Promise.all(
      Array.from({ length: n }, () => mock.client.listModels(ctx.apiKey, createUsageMeter(ctx.target, { kind: "MANAGEMENT" })).catch((e: unknown) => e)),
    );
    expect(results.filter((r) => r instanceof ProviderRateLimitError)).toHaveLength(6);
    expect(mock.calls).toHaveLength(PROVIDER_CHECK_RATE_LIMIT.maxCalls);
    expect(await logs(ctx.user.id)).toHaveLength(PROVIDER_CHECK_RATE_LIMIT.maxCalls);
  });

  it("서로 다른 작업(검증·모델 선택)이 동시에 들어와도 남은 호출 수를 넘지 않는다", async () => {
    const ctx = await setup("con-mixed");
    const mock = createMockGeminiClient({ delayMs: 30 });
    const deps = { client: mock.client, material };
    // 한도 10 중 8회를 먼저 쓴다 → 남은 2회
    for (let i = 0; i < 8; i++) await mock.client.listModels(ctx.apiKey, createUsageMeter(ctx.target, { kind: "MANAGEMENT" }));
    mock.calls.length = 0;

    const [verified, selected] = await Promise.all([
      verifyGeminiConnection(ctx.uid, deps).catch((e: unknown) => e),
      selectGeminiModel(ctx.uid, MODEL, deps).catch((e: unknown) => e),
    ]);
    // 이전 구현은 두 작업 모두 사전 검사를 통과해 3회를 보낼 수 있었다
    expect(mock.calls.length).toBeLessThanOrEqual(2);
    expect([verified, selected].some((r) => r instanceof ProviderRateLimitError)).toBe(true);
    expect(await logs(ctx.user.id)).toHaveLength(8 + mock.calls.length);
  });

  it("목록에 다음 페이지가 있어도 호출 한도를 넘겨 조회하지 않는다 (페이지마다 예약)", async () => {
    const ctx = await setup("con-pages");
    for (let i = 0; i < PROVIDER_CHECK_RATE_LIMIT.maxCalls - 1; i++) {
      await createMockGeminiClient().client.listModels(ctx.apiKey, createUsageMeter(ctx.target, { kind: "MANAGEMENT" }));
    }
    const meter = createUsageMeter(ctx.target, { kind: "MANAGEMENT" });
    await meter({ operation: "models.list", model: null }); // 1페이지 (마지막 1회)
    await expect(meter({ operation: "models.list", model: null })).rejects.toBeInstanceOf(ProviderRateLimitError); // 2페이지는 거부
  });
});

describe("백오프·서킷 브레이커 (연결 단위)", () => {
  it("429 → 즉시 백오프(5초), 열린 동안의 요청은 전송하지 않음(GEMINI_BACKOFF), 자동 재시도 0건", async () => {
    const ctx = await setup("brk-429");
    const { mock, value } = await runSim(ctx, { failProbe: { [MODEL]: "QUOTA_EXCEEDED" } });
    expect(value).toMatchObject({ kind: "QUOTA_EXCEEDED" });
    expect(mock.calls).toHaveLength(1); // 재시도 없음
    expect(await connection(ctx.conn.id)).toMatchObject({ consecutiveFailures: 1, backoffLevel: 1, blockedUntil: plus(T0, BREAKER_BACKOFF_BASE_MS), blockReason: "RATE_LIMITED" });

    const blocked = await runSim(ctx, {}, plus(T0, 1000));
    expect(blocked.value).toBeInstanceOf(CircuitOpenError);
    expect(blocked.value).toMatchObject({ code: "GEMINI_BACKOFF", retryAfterSeconds: 4 });
    expect(blocked.mock.calls).toHaveLength(0);
    expect(await logs(ctx.user.id)).toHaveLength(1);
  });

  it("429 응답의 retryDelay를 백오프보다 우선한다", async () => {
    const ctx = await setup("brk-retry");
    await runSim(ctx, { failProbe: { [MODEL]: "QUOTA_EXCEEDED" }, retryAfterMs: 37_000 });
    expect((await connection(ctx.conn.id)).blockedUntil).toEqual(plus(T0, 37_000));
  });

  it(`5xx·시간 초과·네트워크는 연속 ${BREAKER_TRANSIENT_FAILURE_THRESHOLD}회부터 백오프, 그 전에는 계속 허용`, async () => {
    const ctx = await setup("brk-5xx");
    const kinds = ["UPSTREAM_ERROR", "NETWORK_ERROR", "TIMEOUT"] as const;
    for (let i = 0; i < BREAKER_TRANSIENT_FAILURE_THRESHOLD; i++) {
      const { mock } = await runSim(ctx, { failProbe: { [MODEL]: kinds[i % kinds.length]! } }, plus(T0, i));
      expect(mock.calls).toHaveLength(1);
      const c = await connection(ctx.conn.id);
      expect(c.consecutiveFailures).toBe(i + 1);
      expect(c.blockedUntil === null).toBe(i + 1 < BREAKER_TRANSIENT_FAILURE_THRESHOLD);
    }
    expect(await connection(ctx.conn.id)).toMatchObject({ backoffLevel: 1, blockReason: "UPSTREAM_UNAVAILABLE" });
    expect((await runSim(ctx, {}, plus(T0, 1000))).value).toBeInstanceOf(CircuitOpenError);
  });

  it("성공하면 연속 실패 카운터가 초기화된다", async () => {
    const ctx = await setup("brk-reset");
    await runSim(ctx, { failProbe: { [MODEL]: "UPSTREAM_ERROR" } });
    await runSim(ctx, { failProbe: { [MODEL]: "UPSTREAM_ERROR" } }, plus(T0, 1));
    await runSim(ctx, {}, plus(T0, 2));
    expect(await connection(ctx.conn.id)).toMatchObject({ consecutiveFailures: 0, backoffLevel: 0, blockedUntil: null });
    // 다시 2회 실패해도 임계(3) 전이므로 열리지 않는다
    await runSim(ctx, { failProbe: { [MODEL]: "UPSTREAM_ERROR" } }, plus(T0, 3));
    await runSim(ctx, { failProbe: { [MODEL]: "UPSTREAM_ERROR" } }, plus(T0, 4));
    expect((await connection(ctx.conn.id)).blockedUntil).toBeNull();
  });

  it("개방 → 반열림 시험 1건(동시 요청은 대기) → 성공 시 닫힘", async () => {
    const ctx = await setup("brk-recover");
    await runSim(ctx, { failProbe: { [MODEL]: "QUOTA_EXCEEDED" } });
    const after = plus(T0, BREAKER_BACKOFF_BASE_MS + 1);

    const mock = createMockGeminiClient({ delayMs: 50 });
    const [trial, concurrent] = await Promise.all([
      simCall(ctx, mock, after).result.catch((e: unknown) => e),
      new Promise((r) => setTimeout(r, 15)).then(() => simCall(ctx, mock, plus(after, 10)).result.catch((e: unknown) => e)),
    ]);
    expect(trial).not.toBeInstanceOf(Error);
    expect(concurrent).toBeInstanceOf(CircuitOpenError);
    expect(concurrent).toMatchObject({ reason: BLOCK_REASON.HALF_OPEN });
    expect(mock.calls).toHaveLength(1);
    expect(await connection(ctx.conn.id)).toMatchObject({ consecutiveFailures: 0, backoffLevel: 0, blockedUntil: null, blockReason: null });
    expect((await runSim(ctx, {}, plus(after, 20))).value).not.toBeInstanceOf(Error);
  });

  it("반열림 시험이 실패하면 더 긴 백오프(10초)로 다시 열린다", async () => {
    const ctx = await setup("brk-reopen");
    await runSim(ctx, { failProbe: { [MODEL]: "QUOTA_EXCEEDED" } });
    const after = plus(T0, BREAKER_BACKOFF_BASE_MS + 1);
    await runSim(ctx, { failProbe: { [MODEL]: "UPSTREAM_ERROR" } }, after);
    expect(await connection(ctx.conn.id)).toMatchObject({ backoffLevel: 2, blockedUntil: plus(after, BREAKER_BACKOFF_BASE_MS * 2), blockReason: "UPSTREAM_UNAVAILABLE" });
  });

  it("키 무효(영구 오류) → 연결 INVALID, 이후 요청은 전송 전 차단. 브레이커 카운터는 바꾸지 않는다", async () => {
    const ctx = await setup("brk-key");
    const { mock } = await runSim(ctx, { failProbe: { [MODEL]: "KEY_INVALID" } });
    expect(mock.calls).toHaveLength(1);
    expect(await connection(ctx.conn.id)).toMatchObject({ status: "INVALID", lastErrorCode: "KEY_INVALID", consecutiveFailures: 0, blockedUntil: null });
    const next = await runSim(ctx, {}, plus(T0, 1));
    expect(next.value).toBeInstanceOf(ConnectionNotReadyError);
    expect(next.mock.calls).toHaveLength(0);
  });

  it("요청 단위 오류(모델 없음·미완료 응답)는 브레이커를 바꾸지 않는다", async () => {
    const ctx = await setup("brk-request");
    await runSim(ctx, { failProbe: { [MODEL]: "UPSTREAM_ERROR" } });
    await runSim(ctx, { failProbe: { [MODEL]: "MODEL_NOT_FOUND" } }, plus(T0, 1));
    await runSim(ctx, { failProbe: { [MODEL]: "INCOMPLETE_RESPONSE" } }, plus(T0, 2));
    expect(await connection(ctx.conn.id)).toMatchObject({ status: "ACTIVE", consecutiveFailures: 1, blockedUntil: null });
  });

  it("같은 키(연결)를 쓰는 다른 세계관도 백오프를 공유한다", async () => {
    const ctx = await setup("brk-shared");
    await runSim(ctx, { failProbe: { [MODEL]: "QUOTA_EXCEEDED" } });
    const other = await createTestWorld(ctx.user.id, "다른 세계관");
    const { mock, value } = await runSim({ ...ctx, world: other }, {}, plus(T0, 1000));
    expect(value).toBeInstanceOf(CircuitOpenError);
    expect(mock.calls).toHaveLength(0);
  });

  it("연결 관리용 호출(사용자가 직접 누른 검증)은 브레이커로 막지 않고 브레이커를 바꾸지도 않는다", async () => {
    const ctx = await setup("brk-mgmt");
    await runSim(ctx, { failProbe: { [MODEL]: "QUOTA_EXCEEDED" } });
    const before = await connection(ctx.conn.id);
    await expect(verifyGeminiConnection(ctx.uid, { client: createMockGeminiClient().client, material, now: () => plus(T0, 1000) })).resolves.toMatchObject({ verification: { ok: true } });
    expect(await connection(ctx.conn.id)).toMatchObject({ backoffLevel: before.backoffLevel, blockedUntil: before.blockedUntil, blockReason: before.blockReason });
  });
});

describe("사용자 간 격리", () => {
  it("한 사용자의 한도 도달·백오프는 다른 사용자에게 영향이 없다", async () => {
    const a = await setup("iso-a", { dailyRequestLimit: 1 });
    const b = await setup("iso-b", { dailyRequestLimit: 1 });
    await runSim(a, {});
    expect((await runSim(a, {}, plus(T0, 1))).value).toBeInstanceOf(UsageLimitError);
    expect((await runSim(b, {}, plus(T0, 1))).value).not.toBeInstanceOf(Error);

    const c = await setup("iso-c");
    const d = await setup("iso-d");
    await runSim(c, { failProbe: { [MODEL]: "QUOTA_EXCEEDED" } });
    expect((await runSim(c, {}, plus(T0, 1000))).value).toBeInstanceOf(CircuitOpenError);
    expect((await runSim(d, {}, plus(T0, 1000))).value).not.toBeInstanceOf(Error);

    expect(await daily(a.conn.id)).toMatchObject({ requestCount: 1 });
    expect(await daily(b.conn.id)).toMatchObject({ requestCount: 1 });
  });

  it("연결 관리용 호출 한도는 사용자별이다", async () => {
    const a = await setup("iso-rl-a");
    const b = await setup("iso-rl-b");
    for (let i = 0; i < PROVIDER_CHECK_RATE_LIMIT.maxCalls; i++) await createMockGeminiClient().client.listModels(a.apiKey, createUsageMeter(a.target, { kind: "MANAGEMENT" }));
    await expect(createUsageMeter(a.target, { kind: "MANAGEMENT" })({ operation: "models.list", model: null })).rejects.toBeInstanceOf(ProviderRateLimitError);
    await expect(createMockGeminiClient().client.listModels(b.apiKey, createUsageMeter(b.target, { kind: "MANAGEMENT" }))).resolves.toBeDefined();
  });

  it("다른 사용자의 연결로는 예약할 수 없다 (404, 외부 호출 없음)", async () => {
    const a = await setup("iso-own-a");
    const b = await setup("iso-own-b");
    const forged = { ...b, target: { ...b.target, connectionId: a.conn.id, keyFingerprint: a.conn.keyFingerprint } };
    const { mock, value } = await runSim(forged, {});
    expect(value).toBeInstanceOf(NotFoundError);
    expect(mock.calls).toHaveLength(0);
    expect(await daily(a.conn.id)).toBeNull();
  });
});
