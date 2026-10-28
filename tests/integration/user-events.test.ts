import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { SCENE_IN_FLIGHT_STALE_MS, USER_EVENTS_PER_DAY } from "../../config/limits";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { cancelUserEvent, listPendingUserEvents, submitUserEvent } from "@/server/domain/events/user-events";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { createManualSave, loadSave } from "@/server/domain/saves/saves";
import { generateScene } from "@/server/domain/scenes/generate-scene";
import { runSimulationCommand } from "@/server/domain/simulation/control";
import { runWorldTick } from "@/server/engine/runner/world-tick";
import type { GeminiKeyClient } from "@/server/llm/gemini/client";
import { createMockGeminiClient } from "@/server/llm/mock/gemini-mock";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey } from "./helpers";

// Phase 7-2-3 사용자 지정 사건: 등록 한도·멱등·소유권, 등록 순 1건씩 한 번 발생(발생 완료)·자동 사건과 같은 장면, 점유·취소 경쟁(실패·오래된 시도·늦은 커밋),
// 사용자 사건 강도(위험 확인 없이는 부상·사망 불가), 사건 사실 기억 보완(참가자만·중복 없음), 세이브 v4 복원, SSE(outbox), Gemini 호출 수. 실제 DB + Mock Gemini.

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "user-events-fingerprint-0123456789",
});
const T0 = Date.parse("2026-10-28T03:00:00.000Z"); // KST 12:00
const at = (s: number) => new Date(T0 + s * 1000);

const turns = [
  { speaker: "C1", dialogue: "가", actionIntent: null, emotionCue: null },
  { speaker: "C2", dialogue: "나", actionIntent: null, emotionCue: null },
  { speaker: "C1", dialogue: "다", actionIntent: null, emotionCue: null },
];
const sceneJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ scene: { title: "t", summary: "s", endReason: "RESOLVED" }, turns, proposals: { emotions: [], relationships: [], memories: [] }, ...extra });
const outcome = (ref: string, extra: Record<string, unknown> = {}) => ({ ref, realization: null, usedFallback: false, danger: "NONE", ...extra });
const condition = (character: string, extra: Record<string, unknown>) => ({ character, thermal: null, pain: null, injury: null, treatment: null, death: null, eventRef: null, ...extra });

async function setup(label: string, characters = 2) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  await saveGeminiApiKey(uid, fakeGeminiKey(label), material);
  await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
  const world = await createTestWorld(user.id, `${label} 세계`);
  const chars = [];
  for (let i = 0; i < characters; i++) {
    const c = await prisma.character.create({ data: characterData(world.id, `${label}-${i + 1}`) });
    await prisma.characterCondition.create({ data: { characterId: c.id, worldId: world.id } });
    chars.push(c);
  }
  await prisma.sseConnection.create({ data: { worldId: world.id, userId: user.id, instanceId: "test", lastSeenAt: new Date("2100-01-01T00:00:00.000Z") } });
  const clock = { ms: T0 };
  const prompts: string[] = [];
  /** text: 응답, during: Gemini 호출 중(응답 전)에 할 일 */
  const deps = (text?: string, during?: () => Promise<void>) => {
    const mock = createMockGeminiClient(text ? { generateText: text } : {});
    const client: GeminiKeyClient = {
      ...mock.client,
      generateJson: async (apiKey, request, meter) => {
        prompts.push(request.prompt);
        await during?.();
        return mock.client.generateJson(apiKey, request, meter);
      },
    };
    return { client, material, now: () => new Date(clock.ms), random: () => 0 };
  };
  const submit = (text: string, s: number, requestId = `req-${label}-${s}`) => submitUserEvent(uid, world.id, { text, requestId }, at(s));
  const event = (id: string) => prisma.worldEvent.findUniqueOrThrow({ where: { id } });
  return { user, uid, world, chars, clock, deps, prompts, submit, event };
}

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("등록 한도·멱등·소유권", () => {
  it("첫 장면 뒤에도 등록되고, 같은 requestId는 한 번만, 30초 간격·대기 3건·KST 하루 30건을 지키며 settingsSeq는 그대로다", async () => {
    const { uid, world, deps, submit } = await setup("ue-limits");
    await generateScene(uid, world.id, deps(sceneJson())); // 첫 장면 이후 (설정 잠금과 무관)
    const before = await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } });

    const first = await submit("마을 입구에 우주선이 내려앉았다", 0, "req-same-0001");
    expect(first).toMatchObject({ created: true, event: { text: "마을 입구에 우주선이 내려앉았다", claimed: false } });
    const again = await submit("마을 입구에 우주선이 내려앉았다", 1, "req-same-0001");
    expect(again).toMatchObject({ created: false, event: { id: first.event.id } });
    await expect(submit("다른 내용", 2, "req-same-0001")).rejects.toMatchObject({ code: "USER_EVENT_REQUEST_REUSED" });
    await expect(submit("너무 빠른 두 번째", 10)).rejects.toMatchObject({ status: 429, code: "USER_EVENT_TOO_SOON", retryAfterSeconds: 20 });

    // 동시 제출: World 잠금으로 직렬화되어 30초 간격 안에서는 한 건만 등록된다
    const results = await Promise.allSettled([0, 1, 2, 3, 4].map((i) => submit(`동시 ${i}`, 30, `req-par-${i}-xyz`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await submit("세 번째", 60);
    await expect(submit("네 번째", 90)).rejects.toMatchObject({ code: "USER_EVENT_PENDING_LIMIT" });
    expect(await prisma.worldEvent.count({ where: { worldId: world.id, status: "PENDING" } })).toBe(3);

    const after = await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } });
    expect(after.settingsSeq).toBe(before.settingsSeq);
    expect(after.changeSeq).toBe(before.changeSeq + 3);
    expect(await prisma.simulationEvent.count({ where: { worldId: world.id, type: "world_event.updated" } })).toBe(3); // SSE: 등록만큼

    // 하루 30건 (취소된 사건 포함, KST 날짜 기준)
    await prisma.worldEvent.updateMany({ where: { worldId: world.id, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: at(0) } });
    await prisma.worldEvent.createMany({
      data: Array.from({ length: USER_EVENTS_PER_DAY - 3 }, (_, i) => ({ worldId: world.id, kind: "USER_INTERVENTION" as const, status: "CANCELLED" as const, title: "x", description: "x", createdAt: at(-3600 - i) })),
    });
    await expect(submit("31번째", 200)).rejects.toMatchObject({ code: "USER_EVENT_DAILY_LIMIT" });
    // 다음 KST 날짜(15:00Z = 00:00 KST)에는 다시 가능
    await expect(submitUserEvent(uid, world.id, { text: "다음 날", requestId: "req-next-day" }, new Date("2026-10-28T15:00:01.000Z"))).resolves.toMatchObject({ created: true });
  });

  it("타인 세계관·타인 사건은 등록·취소 모두 404", async () => {
    const { uid, world, submit } = await setup("ue-owner");
    const other = await setup("ue-owner-other");
    const { event } = await submit("낯선 상인이 찾아왔다", 0);
    await expect(submitUserEvent(other.uid, world.id, { text: "침입", requestId: "req-intruder" }, at(100))).rejects.toMatchObject({ status: 404 });
    await expect(cancelUserEvent(other.uid, world.id, event.id, at(100))).rejects.toMatchObject({ status: 404 });
    await expect(cancelUserEvent(other.uid, other.world.id, event.id, at(100))).rejects.toMatchObject({ status: 404 });
    expect((await prisma.worldEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("PENDING");
    expect(uid).toBeDefined();
  });
});

describe("발생 순서·자동 사건과 같은 장면", () => {
  it("대기 사건은 등록 순으로 장면마다 1건씩 한 번 발생하고(자동 사건과 같은 장면 가능), 이후 장면에 다시 주입하지 않으며, Gemini 호출은 장면당 1회다", async () => {
    const { uid, world, deps, prompts, submit, event } = await setup("ue-order");
    await prisma.gameState.update({ where: { worldId: world.id }, data: { nextSceneSeq: 3 } });
    await prisma.worldEventPeriod.create({ data: { worldId: world.id, periodIndex: 0, won: true, scheduledSceneSeq: 3 } });
    const a = (await submit("하늘에서 거대한 호랑이 석상이 떨어졌다", 0)).event;
    const b = (await submit("먼 곳에서 편지 한 통이 도착했다", 30)).event;

    const first = await generateScene(uid, world.id, deps(sceneJson()));
    expect(prompts.at(-1)).toContain("「하늘에서 거대한 호랑이 석상이 떨어졌다」"); // 원문 그대로
    expect(prompts.at(-1)).not.toContain("먼 곳에서 편지");
    expect(await event(a.id)).toMatchObject({ status: "RESOLVED", startedSceneSeq: 3, resolvedSceneSeq: 3, resolutionSummary: null, claimedAttemptId: null, intensity: "MEDIUM", description: "하늘에서 거대한 호랑이 석상이 떨어졌다" });
    expect(await event(b.id)).toMatchObject({ status: "PENDING", claimedAttemptId: null });
    expect(await prisma.worldEvent.count({ where: { worldId: world.id, kind: "RANDOM", status: "RESOLVED", startedSceneSeq: 3 } })).toBe(1); // 자동 사건도 같은 장면에 발생
    expect(first.notes).toContainEqual({ kind: "USER_EVENT_STARTED", text: "사용자가 일으킨 사건: 하늘에서 거대한 호랑이 석상이 떨어졌다" });
    expect(first.notes.filter((n) => n.kind === "EVENT_STARTED")).toHaveLength(1);

    await generateScene(uid, world.id, deps(sceneJson()));
    expect(await event(b.id)).toMatchObject({ status: "RESOLVED", startedSceneSeq: 4 });
    expect(await event(a.id)).toMatchObject({ status: "RESOLVED", lastSceneSeq: 3 }); // 발생한 사건은 다시 다루지 않는다
    expect(prompts.at(-1)).toContain("「먼 곳에서 편지 한 통이 도착했다」");
    expect(prompts.at(-1)).not.toContain("「하늘에서");
    expect(prompts).toHaveLength(2); // 장면 2개 = Gemini 호출 2회
    expect(await prisma.apiRequestLog.count({ where: { worldId: world.id } })).toBe(2);
    expect(await prisma.simulationEvent.count({ where: { worldId: world.id, type: "world_event.updated", payload: { path: ["reason"], equals: "started" } } })).toBe(2);
  });
});

describe("점유와 취소 경쟁", () => {
  it("생성 중에는 점유된 사건을 취소할 수 없고 커밋되면 발생 완료라 역시 취소할 수 없다. 점유되지 않은 다음 사건은 취소된다", async () => {
    const { uid, world, deps, submit, event, clock } = await setup("ue-cancel-busy");
    const a = (await submit("폭풍이 몰아친다", 0)).event;
    const b = (await submit("배가 난파했다", 30)).event;
    let during: unknown[] = [];
    await generateScene(
      uid,
      world.id,
      deps(sceneJson(), async () => {
        expect((await listPendingUserEvents(world.id, new Date(clock.ms))).map((e) => e.claimed)).toEqual([true, false]);
        during = await Promise.allSettled([cancelUserEvent(uid, world.id, a.id, new Date(clock.ms)), cancelUserEvent(uid, world.id, b.id, new Date(clock.ms))]);
      }),
    );
    expect(during[0]).toMatchObject({ status: "rejected", reason: { code: "USER_EVENT_IN_PROGRESS" } });
    expect(during[1]).toMatchObject({ status: "fulfilled" });
    expect(await event(a.id)).toMatchObject({ status: "RESOLVED", startedSceneSeq: 1 });
    expect(await event(b.id)).toMatchObject({ status: "CANCELLED", claimedAttemptId: null });
    await expect(cancelUserEvent(uid, world.id, a.id, new Date(clock.ms))).rejects.toMatchObject({ code: "USER_EVENT_NOT_CANCELLABLE" });
    expect(await prisma.simulationEvent.count({ where: { worldId: world.id, type: "world_event.updated", payload: { path: ["reason"], equals: "cancelled" } } })).toBe(1);
  });

  it("생성 실패(검증 실패)면 점유가 풀려 취소할 수 있고, 취소된 사건은 다음 장면 프롬프트에 나오지 않는다", async () => {
    const { uid, world, deps, prompts, submit, event, clock } = await setup("ue-cancel-fail");
    const a = (await submit("지하실에서 이상한 소리가 난다", 0)).event;
    await expect(generateScene(uid, world.id, deps("not json"))).rejects.toMatchObject({ code: "SCENE_VALIDATION_FAILED" });
    expect(prompts.at(-1)).toContain("지하실에서 이상한 소리");
    expect(await event(a.id)).toMatchObject({ status: "PENDING", claimedAttemptId: null });
    await cancelUserEvent(uid, world.id, a.id, new Date(clock.ms));
    await generateScene(uid, world.id, deps(sceneJson()));
    expect(prompts.at(-1)).not.toContain("지하실에서 이상한 소리");
    expect(await event(a.id)).toMatchObject({ status: "CANCELLED", startedSceneSeq: null });
  });

  it("점유한 시도가 오래되어 취소된 뒤 그 시도가 늦게 커밋하려 하면 장면 전체를 저장하지 않는다 (취소된 사건이 대사에 남지 않음)", async () => {
    const { uid, world, deps, submit, event, clock } = await setup("ue-cancel-late");
    const a = (await submit("성문이 무너졌다", 0)).event;
    await expect(
      generateScene(
        uid,
        world.id,
        deps(sceneJson(), async () => {
          clock.ms += SCENE_IN_FLIGHT_STALE_MS + 1000; // 시도가 끝난 것으로 보일 만큼 지남
          await cancelUserEvent(uid, world.id, a.id, new Date(clock.ms));
        }),
      ),
    ).rejects.toMatchObject({ code: "SCENE_STALE" });
    expect(await prisma.conversationScene.count({ where: { worldId: world.id } })).toBe(0);
    expect(await event(a.id)).toMatchObject({ status: "CANCELLED", startedSceneSeq: null });
  });

  it("Runner 시도가 실패하면 finishAttempt에서 점유를 풀고, 다음 시도가 같은 사건을 다시 점유해 발생시킨다", async () => {
    const { uid, world, deps, submit, event, clock } = await setup("ue-runner");
    const a = (await submit("우물이 말라붙었다", 0)).event;
    const failing = deps("not json");
    await runSimulationCommand(uid, world.id, "start", failing.now);
    clock.ms += 1000;
    await runWorldTick(world.id, { owner: "host-a", deps: failing, state: { failures: 0 } });
    expect(await event(a.id)).toMatchObject({ status: "PENDING", claimedAttemptId: null });
    expect(await prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId: world.id } })).toMatchObject({ inFlightAttemptId: null });
    clock.ms += 10 * 60 * 1000;
    const ok = deps(sceneJson());
    await runWorldTick(world.id, { owner: "host-a", deps: ok, state: { failures: 0 } });
    expect(await event(a.id)).toMatchObject({ status: "RESOLVED", startedSceneSeq: 1 });
  });
});

describe("사용자 사건 강도", () => {
  it("위험이 확인되지 않은 사용자 사건을 원인으로 한 부상·사망은 무시하고, 실제 공격이 보고되면 고강도 악화·치명적 결과를 허용한다", async () => {
    const { uid, world, chars, deps, submit } = await setup("ue-danger");
    await prisma.characterCondition.update({ where: { characterId: chars[0]!.id }, data: { injury: "MODERATE", injuryCause: "넘어짐", injuryUpdatedAtSeconds: 0 } });
    await submit("낯선 방문자가 찾아왔다", 0);
    await submit("무장한 도적 떼가 마을을 덮쳤다", 30);
    const fatal = (danger: string) =>
      sceneJson({
        events: [outcome("E1", { danger })],
        conditions: [condition("C1", { injury: { level: "CRITICAL", cause: "습격당함" }, death: { cause: "치명상" }, eventRef: "E1" })],
      });
    // 1) 방문(danger NONE): 그 사건을 원인으로 한 부상·사망 제안은 버린다
    await generateScene(uid, world.id, deps(fatal("NONE")));
    expect(await prisma.characterCondition.findUniqueOrThrow({ where: { characterId: chars[0]!.id } })).toMatchObject({ injury: "MODERATE", vital: "ALIVE" });
    // 2) 다음 사건에서 실제 공격이 보고되면(danger ATTACK) 고강도 한도: 아픔 → 위독, 이번 장면의 치명적 결과로 사망 인정
    await generateScene(uid, world.id, deps(fatal("ATTACK")));
    expect(await prisma.characterCondition.findUniqueOrThrow({ where: { characterId: chars[0]!.id } })).toMatchObject({ injury: "CRITICAL", vital: "DEAD", deathCause: "치명상" });
    expect(await prisma.worldEvent.count({ where: { worldId: world.id, status: "RESOLVED" } })).toBe(2); // 사건이 지나도 상태는 그대로
  });
});

describe("사건 기억 (사건별 보장)", () => {
  /** 장면 #3: 자동 사건(E1, discovery_traces) + 사용자 사건(E2)이 같은 장면에 발생하도록 준비. 참가자 C1·C2, 비참가자 1명 */
  async function sameScene(label: string) {
    const ctx = await setup(label, 3);
    await prisma.gameState.update({ where: { worldId: ctx.world.id }, data: { nextSceneSeq: 3 } });
    await prisma.worldEventPeriod.create({ data: { worldId: ctx.world.id, periodIndex: 0, won: true, scheduledSceneSeq: 3, presetId: "discovery_traces" } });
    const user = (await ctx.submit("숲에서 빛나는 알이 발견되었다", 0)).event;
    const auto = async () => (await prisma.worldEventPeriod.findFirstOrThrow({ where: { worldId: ctx.world.id } })).eventId;
    /** 소유자별 사건 기억 (shareGroupId) */
    const byOwner = async () => {
      const rows = await prisma.characterMemory.findMany({ where: { worldId: ctx.world.id }, orderBy: { createdAt: "asc" } });
      return ctx.chars.map((c) => rows.filter((m) => m.ownerCharacterId === c.id));
    };
    return { ...ctx, user, auto, byOwner };
  }
  const mem = (owner: string, content: string, eventRef: string | null) => ({ owner, about: null, kind: "EVENT", acquisition: "WITNESSED", content, importance: 4, eventRef });
  const withMemories = (memories: unknown[]) => sceneJson({ proposals: { emotions: [], relationships: [], memories } });

  it("자동+사용자 사건이 같은 장면에 발생하면 참가자마다 두 사건 모두의 기억이 남는다. 사건을 가리킨 모델 기억은 그 사건 보완을 대신하고, 사건을 모르는 기억은 세지 않는다", async () => {
    const { uid, world, deps, user, auto, byOwner } = await sameScene("ue-mem-both");
    await generateScene(uid, world.id, deps(withMemories([mem("C1", "빛나는 알을 내 손으로 주웠다", "E2"), mem("C2", "숲이 이상하게 조용했다", null)])));
    const autoId = await auto();
    const [c1, c2, c3] = await byOwner();
    // C1: 모델 기억(E2 → 사용자 사건) + 자동 사건 서버 보완
    expect(c1!.map((m) => [m.shareGroupId, m.content.startsWith("이 사건을 직접 겪었다")])).toEqual(
      expect.arrayContaining([
        [user.id, false],
        [autoId, true],
      ]),
    );
    expect(c1).toHaveLength(2);
    // C2: 사건을 모르는 모델 기억은 그대로 두고 두 사건 모두 서버 보완
    expect(c2!.filter((m) => m.shareGroupId === null).map((m) => m.content)).toEqual(["숲이 이상하게 조용했다"]);
    expect(c2!.flatMap((m) => (m.shareGroupId ? [m.shareGroupId] : [])).sort()).toEqual([autoId, user.id].sort());
    expect(c3).toEqual([]); // 비참가자
  });

  it("모델이 두 사건 기억을 모두 냈으면 서버 기억을 만들지 않고, 모르는 별칭(E9)은 사건과 잇지 않는다", async () => {
    const { uid, world, deps, user, auto, byOwner } = await sameScene("ue-mem-dup");
    await generateScene(uid, world.id, deps(withMemories([mem("C1", "흔적을 따라갔다", "E1"), mem("C1", "알이 따뜻했다", "E2"), mem("C2", "무언가 봤다", "E9")])));
    const autoId = await auto();
    const [c1, c2] = await byOwner();
    expect(c1!.map((m) => m.shareGroupId).sort()).toEqual([autoId, user.id].sort());
    expect(c1!.every((m) => !m.content.startsWith("이 사건을 직접 겪었다"))).toBe(true);
    expect(c2!.find((m) => m.content === "무언가 봤다")?.shareGroupId).toBeNull();
    expect(c2!.filter((m) => m.shareGroupId !== null)).toHaveLength(2);
    // 사건·참가자마다 정확히 하나 (중복 없음)
    const all = await prisma.characterMemory.findMany({ where: { worldId: world.id, shareGroupId: { not: null } } });
    expect(new Set(all.map((m) => `${m.ownerCharacterId}:${m.shareGroupId}`)).size).toBe(all.length);
  });

  it("검증 실패·펜싱 실패면 사건·기억이 함께 롤백되고, 다시 시도해 성공하면 참가자×사건마다 기억이 정확히 하나다", async () => {
    const { uid, world, deps, user, event, byOwner } = await sameScene("ue-mem-rollback");
    await expect(generateScene(uid, world.id, deps("not json"))).rejects.toMatchObject({ code: "SCENE_VALIDATION_FAILED" });
    const fenced = deps(withMemories([mem("C1", "흔적을 따라갔다", "E1")]), async () => {
      await prisma.$executeRaw`UPDATE "GameState" SET "settingsSeq" = "settingsSeq" + 1 WHERE "worldId" = ${world.id}`;
    });
    await expect(generateScene(uid, world.id, fenced)).rejects.toMatchObject({ code: "SETTINGS_CHANGED" });
    expect(await prisma.characterMemory.count({ where: { worldId: world.id } })).toBe(0);
    expect(await prisma.worldEvent.count({ where: { worldId: world.id, status: "RESOLVED" } })).toBe(0);
    expect(await event(user.id)).toMatchObject({ status: "PENDING", claimedAttemptId: null });
    expect(await prisma.worldEventPeriod.findFirstOrThrow({ where: { worldId: world.id } })).toMatchObject({ firedAt: null, eventId: null });

    await generateScene(uid, world.id, deps(withMemories([mem("C1", "흔적을 따라갔다", "E1")])));
    const [c1, c2, c3] = await byOwner();
    expect(c1).toHaveLength(2);
    expect(c2).toHaveLength(2);
    expect(c3).toEqual([]);
    expect(await prisma.worldEvent.count({ where: { worldId: world.id, status: "RESOLVED", startedSceneSeq: 3, resolvedSceneSeq: 3 } })).toBe(2);
  });
});

describe("세이브 v4", () => {
  it("대기·발생 완료 사용자 사건을 저장하고, 불러오면 원문·requestId·상태·사건 기억이 복원되며 점유는 비어 있다", async () => {
    const { uid, world, deps, submit, event, clock } = await setup("ue-save");
    const a = (await submit("용이 산 위를 날아갔다", 0, "req-save-a")).event;
    await generateScene(uid, world.id, deps(sceneJson())); // a 발생 완료
    const b = (await submit("왕국에서 사절단이 왔다", 30, "req-save-b")).event;
    const save = await createManualSave(uid, world.id, "사건 저장", new Date(clock.ms));

    await cancelUserEvent(uid, world.id, b.id, new Date(clock.ms));
    await generateScene(uid, world.id, deps(sceneJson()));
    expect(await prisma.characterMemory.count({ where: { worldId: world.id } })).toBe(2);

    await loadSave(uid, world.id, save.id, new Date(clock.ms));
    expect(await event(a.id)).toMatchObject({ status: "RESOLVED", requestId: "req-save-a", description: "용이 산 위를 날아갔다", startedSceneSeq: 1, resolvedSceneSeq: 1 });
    expect(await event(b.id)).toMatchObject({ status: "PENDING", requestId: "req-save-b", claimedAttemptId: null, cancelledAt: null });
    expect(await prisma.characterMemory.count({ where: { worldId: world.id, shareGroupId: a.id } })).toBe(2); // 사건 기억도 복원
    // 복원 뒤 다음 장면에서 대기 사건이 발생한다
    await generateScene(uid, world.id, deps(sceneJson()));
    expect(await event(b.id)).toMatchObject({ status: "RESOLVED", startedSceneSeq: 2 });
  });
});
