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

// Phase 7-2-3 사용자 지정 사건: 등록 한도·멱등·소유권, 등록 순 1건씩 발생·자동 사건과 동시 진행, 점유·취소 경쟁(실패·오래된 시도·늦은 커밋),
// 사용자 사건 강도(위험 확인 없이는 부상·사망 불가), 해결 판정, 세이브 v4 복원, SSE(outbox), Gemini 호출 수. 실제 DB + Mock Gemini.

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
const outcome = (ref: string, extra: Record<string, unknown> = {}) => ({ ref, status: "ONGOING", resolutionSummary: null, realization: null, usedFallback: false, resolutionKind: null, danger: "NONE", ...extra });
const condition = (character: string, extra: Record<string, unknown>) => ({ character, thermal: null, pain: null, injury: null, treatment: null, death: null, eventRef: null, ...extra });

async function setup(label: string) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  await saveGeminiApiKey(uid, fakeGeminiKey(label), material);
  await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
  const world = await createTestWorld(user.id, `${label} 세계`);
  const chars = [];
  for (let i = 0; i < 2; i++) {
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

describe("발생 순서·자동 사건과 동시 진행", () => {
  it("대기 사건은 등록 순으로 장면마다 1건씩 발생하고, 같은 장면의 자동 사건·기존 사건과 함께 진행되며, Gemini 호출은 장면당 1회다", async () => {
    const { uid, world, deps, prompts, submit, event } = await setup("ue-order");
    await prisma.gameState.update({ where: { worldId: world.id }, data: { nextSceneSeq: 3 } });
    await prisma.worldEventPeriod.create({ data: { worldId: world.id, periodIndex: 0, won: true, scheduledSceneSeq: 3 } });
    const a = (await submit("하늘에서 거대한 호랑이 석상이 떨어졌다", 0)).event;
    const b = (await submit("먼 곳에서 편지 한 통이 도착했다", 30)).event;

    const first = await generateScene(uid, world.id, deps(sceneJson()));
    expect(prompts.at(-1)).toContain("「하늘에서 거대한 호랑이 석상이 떨어졌다」"); // 원문 그대로
    expect(prompts.at(-1)).not.toContain("먼 곳에서 편지");
    expect(await event(a.id)).toMatchObject({ status: "ACTIVE", startedSceneSeq: 3, claimedAttemptId: null, intensity: "MEDIUM", description: "하늘에서 거대한 호랑이 석상이 떨어졌다" });
    expect(await event(b.id)).toMatchObject({ status: "PENDING", claimedAttemptId: null });
    expect(await prisma.worldEvent.count({ where: { worldId: world.id, kind: "RANDOM", status: "ACTIVE" } })).toBe(1); // 자동 사건도 같은 장면에 발생
    expect(first.notes).toContainEqual({ kind: "USER_EVENT_STARTED", text: "사용자가 일으킨 사건: 하늘에서 거대한 호랑이 석상이 떨어졌다" });
    expect(first.notes.filter((n) => n.kind === "EVENT_STARTED")).toHaveLength(1);

    await generateScene(uid, world.id, deps(sceneJson()));
    expect(await event(b.id)).toMatchObject({ status: "ACTIVE", startedSceneSeq: 4 });
    expect(await event(a.id)).toMatchObject({ status: "ACTIVE", lastSceneSeq: 4 }); // 기존 사건 유지
    expect(prompts.at(-1)).toMatch(/\[E\d\] \(진행 중 · 장면 #3[^\n]*사용자가 일으킨 사건\) 「하늘에서/);
    expect(prompts).toHaveLength(2); // 장면 2개 = Gemini 호출 2회
    expect(await prisma.apiRequestLog.count({ where: { worldId: world.id } })).toBe(2);
    expect(await prisma.simulationEvent.count({ where: { worldId: world.id, type: "world_event.updated", payload: { path: ["reason"], equals: "started" } } })).toBe(2);
  });
});

describe("점유와 취소 경쟁", () => {
  it("생성 중에는 점유된 사건을 취소할 수 없고 커밋되면 ACTIVE가 되어 역시 취소할 수 없다. 점유되지 않은 다음 사건은 취소된다", async () => {
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
    expect(await event(a.id)).toMatchObject({ status: "ACTIVE" });
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
    expect(await event(a.id)).toMatchObject({ status: "ACTIVE", startedSceneSeq: 1 });
  });
});

describe("사용자 사건 강도와 해결 판정", () => {
  it("위험이 확인되지 않은 사용자 사건을 원인으로 한 부상·사망은 무시하고, 실제 공격이 보고되면 고강도 악화·치명적 결과를 허용한다", async () => {
    const { uid, world, chars, deps, submit } = await setup("ue-danger");
    await prisma.characterCondition.update({ where: { characterId: chars[0]!.id }, data: { injury: "MODERATE", injuryCause: "넘어짐", injuryUpdatedAtSeconds: 0 } });
    await submit("낯선 방문자가 찾아왔다", 0);
    const fatal = (danger: string) =>
      sceneJson({
        events: [outcome("E1", { danger })],
        conditions: [condition("C1", { injury: { level: "CRITICAL", cause: "방문자에게 습격당함" }, death: { cause: "치명상" }, eventRef: "E1" })],
      });
    // 1) 방문만(danger NONE): 그 사건을 원인으로 한 부상·사망 제안은 버린다
    await generateScene(uid, world.id, deps(fatal("NONE")));
    expect(await prisma.characterCondition.findUniqueOrThrow({ where: { characterId: chars[0]!.id } })).toMatchObject({ injury: "MODERATE", vital: "ALIVE" });
    // 2) 실제 공격이 보고되면(danger ATTACK) 고강도 한도: 아픔 → 위독, 이번 장면의 치명적 결과로 사망 인정
    await generateScene(uid, world.id, deps(fatal("ATTACK")));
    expect(await prisma.characterCondition.findUniqueOrThrow({ where: { characterId: chars[0]!.id } })).toMatchObject({ injury: "CRITICAL", vital: "DEAD", deathCause: "치명상" });
  });

  it("발생·발견만 말하는 해결, 결과 종류 없는 해결, 중강도 새 사건의 첫 장면 해결은 받지 않고 ACTIVE로 둔다", async () => {
    const { uid, world, deps, submit, event } = await setup("ue-resolve");
    await prisma.gameState.update({ where: { worldId: world.id }, data: { nextSceneSeq: 3 } });
    await prisma.worldEventPeriod.create({ data: { worldId: world.id, periodIndex: 0, won: true, scheduledSceneSeq: 3, presetId: "discovery_traces" } });
    const a = (await submit("숲에서 빛나는 알이 발견되었다", 0)).event;
    // 장면 #3: 저강도 자동 사건(E1, 새)과 사용자 사건(E2, 새, MEDIUM) 모두 첫 장면 해결 시도
    await generateScene(
      uid,
      world.id,
      deps(sceneJson({ events: [outcome("E1", { status: "RESOLVED", resolutionKind: "SOLVED", resolutionSummary: "수상한 흔적을 발견했다" }), outcome("E2", { status: "RESOLVED", resolutionKind: "SOLVED", resolutionSummary: "알을 안전한 곳에 옮겨 해결했다" })] })),
    );
    const auto = await prisma.worldEvent.findFirstOrThrow({ where: { worldId: world.id, kind: "RANDOM" } });
    expect(auto).toMatchObject({ presetId: "discovery_traces", status: "ACTIVE" });
    expect(await event(a.id)).toMatchObject({ status: "ACTIVE" });
    await prisma.worldEvent.update({ where: { id: auto.id }, data: { createdAt: at(-100) } }); // 같은 장면에 시작한 두 사건의 순서 고정: E1 자동, E2 사용자
    // 장면 #4: 결과 종류 없음 → 무시, 계획만 → 무시
    await generateScene(
      uid,
      world.id,
      deps(sceneJson({ events: [outcome("E1", { status: "RESOLVED", resolutionSummary: "흔적의 주인을 찾아냈다" }), outcome("E2", { status: "RESOLVED", resolutionKind: "SOLVED", resolutionSummary: "알을 숲에 돌려보내기로 했다" })] })),
    );
    expect(await prisma.worldEvent.count({ where: { worldId: world.id, status: "ACTIVE" } })).toBe(2);
    // 장면 #5: 명시적인 결과 → 해결 (각자 자기 사건만)
    await generateScene(uid, world.id, deps(sceneJson({ events: [outcome("E2", { status: "RESOLVED", resolutionKind: "SOLVED", resolutionSummary: "알을 숲 속 둥지에 돌려놓아 일이 마무리됐다" })] })));
    expect(await event(a.id)).toMatchObject({ status: "RESOLVED", resolvedSceneSeq: 5 });
    expect(await prisma.worldEvent.findUniqueOrThrow({ where: { id: auto.id } })).toMatchObject({ status: "ACTIVE" });
  });
});

describe("세이브 v4", () => {
  it("대기·진행 중 사용자 사건을 저장하고, 불러오면 원문·requestId·상태가 복원되며 점유는 비어 있다", async () => {
    const { uid, world, deps, submit, event, clock } = await setup("ue-save");
    const a = (await submit("용이 산 위를 날아갔다", 0, "req-save-a")).event;
    await generateScene(uid, world.id, deps(sceneJson())); // a → ACTIVE
    const b = (await submit("왕국에서 사절단이 왔다", 30, "req-save-b")).event;
    const save = await createManualSave(uid, world.id, "사건 저장", new Date(clock.ms));

    await cancelUserEvent(uid, world.id, b.id, new Date(clock.ms));
    await generateScene(uid, world.id, deps(sceneJson({ events: [outcome("E1", { status: "RESOLVED", resolutionKind: "THREAT_GONE", resolutionSummary: "용이 멀리 떠났다" })] })));
    expect(await event(a.id)).toMatchObject({ status: "RESOLVED" });

    await loadSave(uid, world.id, save.id, new Date(clock.ms));
    expect(await event(a.id)).toMatchObject({ status: "ACTIVE", requestId: "req-save-a", description: "용이 산 위를 날아갔다", resolvedSceneSeq: null });
    expect(await event(b.id)).toMatchObject({ status: "PENDING", requestId: "req-save-b", claimedAttemptId: null, cancelledAt: null });
    // 복원 뒤 다음 장면에서 대기 사건이 발생한다
    await generateScene(uid, world.id, deps(sceneJson()));
    expect(await event(b.id)).toMatchObject({ status: "ACTIVE", startedSceneSeq: 2 });
  });
});
