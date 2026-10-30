import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { AUTO_SAVE_INTERVAL_MS, AUTO_SAVE_RETRY_MS } from "../../config/limits";
import { readProviderKeyMaterial } from "@/server/crypto/provider-key-crypto";
import { prisma } from "@/server/db/client";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { saveGeminiApiKey } from "@/server/domain/providers/gemini-connection";
import { createManualSave, deleteManualSave, listSaves, loadSave, overwriteManualSave, renameManualSave, runAutoSave } from "@/server/domain/saves/saves";
import { captureSnapshot, parseSnapshot, snapshotChecksum } from "@/server/domain/saves/snapshot";
import { generateScene, prepareScene, runSceneAttempt } from "@/server/domain/scenes/generate-scene";
import { runSimulationCommand } from "@/server/domain/simulation/control";
import { updateCharacter } from "@/server/domain/characters/characters";
import { createMockGeminiClient, type MockGeminiScript } from "@/server/llm/mock/gemini-mock";
import { characterData, cleanupTestUsers, createTestUser, createTestWorld, fakeGeminiKey, testAvatar } from "./helpers";

// 세이브 (Phase 6). 실제 DB + Mock Gemini. 슬롯 정책, 자동 저장 순환·간격, 스냅샷 검증, 원자적 복원, 실행 중 차단, 펜싱, 롤백, 복구 지점.

/** 설정 수정 (첫 장면 뒤 세계관은 잠기므로 캐릭터 설정을 바꾼다, PRD v1.8) */
const renamed = (name: string) => ({
  name,
  gender: "FEMALE" as const,
  age: 30,
  personalityTags: ["reserved", "cautious", "sensitive"],
  characterContext: "",
  childhoodBackgroundId: "childhood_bookworm",
  adulthoodBackgroundId: "adulthood_scientist",
  avatarId: testAvatar("FEMALE", name),
});

const material = readProviderKeyMaterial({
  PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_FINGERPRINT_SECRET: "saves-fingerprint-secret-0123456789",
});

const SCENE = JSON.stringify({
  scene: { title: "약속", summary: "등대에 가기로 했다.", endReason: "RESOLVED" },
  turns: ["C1", "C2", "C1"].map((speaker, i) => ({ speaker, dialogue: `대사 ${i}`, actionIntent: null, emotionCue: null })),
  proposals: {
    emotions: [{ character: "C1", mood: "HAPPY", intensityDelta: 10 }],
    relationships: [{ from: "C1", to: "C2", affinity: 3, trust: 1, respect: 0, familiarity: 2, reason: "약속" }],
    memories: [{ owner: "C1", about: "C2", kind: "PROMISE", acquisition: "WITNESSED", content: "등대에 가기로 했다", importance: 4 }],
  },
});

async function setup(label: string, script: MockGeminiScript = { generateText: SCENE }) {
  const user = await createTestUser(label);
  const uid = asAuthenticatedUserId(user.id);
  await saveGeminiApiKey(uid, fakeGeminiKey(label), material);
  await prisma.aiProviderConnection.updateMany({ where: { userId: user.id }, data: { status: "ACTIVE", defaultModel: "gemini-mock-flash" } });
  const world = await createTestWorld(user.id, `${label} 세계`);
  const chars = [];
  for (const name of ["가람", "나래"]) {
    const c = await prisma.character.create({ data: characterData(world.id, name) });
    await prisma.emotionState.create({ data: { characterId: c.id, worldId: world.id, mood: "NEUTRAL", intensity: 50 } });
    chars.push(c);
  }
  const mock = createMockGeminiClient(script);
  return { user, uid, world, chars, mock, deps: { client: mock.client, material, random: () => 0 } };
}

const at = (ms: number) => new Date(Date.UTC(2026, 9, 28, 0, 0, 0) + ms);
const H = AUTO_SAVE_INTERVAL_MS;
const current = (worldId: string) => prisma.$transaction((tx) => captureSnapshot(tx, worldId, at(0)));
const runtime = (worldId: string) => prisma.simulationRuntime.findUniqueOrThrow({ where: { worldId } });
const recoveryRow = (worldId: string) => prisma.saveGame.findUniqueOrThrow({ where: { recoveryForWorldId: worldId } });

afterAll(async () => {
  await cleanupTestUsers();
  await prisma.$disconnect();
});

describe("수동 저장", () => {
  it("동시 요청에도 5개까지만 만들고, 덮어쓰기·이름 변경·삭제는 수동 저장만, 타인 세계관은 404", async () => {
    const { uid, world } = await setup("save-manual");
    const results = await Promise.allSettled(Array.from({ length: 7 }, (_, i) => createManualSave(uid, world.id, `저장 ${i}`)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(["SAVE_SLOT_LIMIT", "SAVE_SLOT_LIMIT"]);

    const [first] = (await listSaves(uid, world.id)).saves;
    const before = (await prisma.saveGame.findUniqueOrThrow({ where: { id: first!.id } })).snapshotId;
    await overwriteManualSave(uid, world.id, first!.id);
    const after = await prisma.saveGame.findUniqueOrThrow({ where: { id: first!.id } });
    expect(after.snapshotId).not.toBe(before);
    expect(await prisma.gameSnapshot.count({ where: { id: before! } })).toBe(0); // 이전 스냅샷 정리
    expect((await renameManualSave(uid, world.id, first!.id, "새 이름")).name).toBe("새 이름");
    await deleteManualSave(uid, world.id, first!.id);
    expect((await listSaves(uid, world.id)).saves).toHaveLength(4);

    const recovery = await recoveryRow(world.id);
    await expect(renameManualSave(uid, world.id, recovery.id, "x")).rejects.toBeInstanceOf(NotFoundError);
    const other = await setup("save-manual-other");
    await expect(createManualSave(other.uid, world.id, "침입")).rejects.toBeInstanceOf(NotFoundError);
    await expect(listSaves(other.uid, world.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("자동 저장", () => {
  it("RUNNING이고 1시간이 지났을 때만 저장, 슬롯 1→2→3→4→5→1 순환, 수동 저장은 덮어쓰지 않고, 목록은 최신순", async () => {
    const { uid, world } = await setup("save-auto");
    const manual = await createManualSave(uid, world.id, "수동", at(30 * 60_000));
    await runSimulationCommand(uid, world.id, "start", () => at(0));
    expect((await runtime(world.id)).nextAutoSaveAt).toEqual(at(H)); // 시작만으로 저장하지 않음
    expect(await runAutoSave(world.id, at(0))).toBe("skipped");

    const slots: number[] = [];
    for (let i = 1; i <= 6; i++) {
      // 동시에 두 번 불러도 한 번만 저장 (여러 RunnerHost)
      const results = await Promise.all([runAutoSave(world.id, at(i * H)), runAutoSave(world.id, at(i * H))]);
      expect(results.filter((r) => r === "saved")).toHaveLength(1);
      const latest = (await listSaves(uid, world.id)).saves[0]!;
      slots.push(latest.autoSlot!);
      expect(latest.name).toBe(`save-auto 세계 - Auto Save ${latest.autoSlot}`);
      expect(await runAutoSave(world.id, at(i * H + 1))).toBe("skipped"); // 다음 저장은 1시간 뒤
    }
    expect(slots).toEqual([1, 2, 3, 4, 5, 1]);

    const list = await listSaves(uid, world.id);
    expect(list.saves).toHaveLength(6); // 자동 5 + 수동 1
    expect(list.saves.map((s) => s.savedAt)).toEqual([...list.saves.map((s) => s.savedAt)].sort().reverse());
    expect(list.saves.find((s) => s.kind === "MANUAL")).toMatchObject({ id: manual.id, savedAt: manual.savedAt });

    // PAUSED에서는 저장하지 않고, 재개는 예정 시각을 유지하거나(남아 있으면) 1시간 뒤로 둔다
    await runSimulationCommand(uid, world.id, "pause", () => at(6 * H + 10));
    expect(await runAutoSave(world.id, at(9 * H))).toBe("skipped");
    await runSimulationCommand(uid, world.id, "resume", () => at(9 * H));
    expect((await runtime(world.id)).nextAutoSaveAt).toEqual(at(10 * H));
  });

  it("저장이 실패하면 기존 스냅샷을 두고 재시도 간격 뒤로 미룬다", async () => {
    const { uid, world } = await setup("save-auto-fail");
    await runSimulationCommand(uid, world.id, "start", () => at(0));
    await runAutoSave(world.id, at(H));
    const saved = await prisma.saveGame.findFirstOrThrow({ where: { worldId: world.id, kind: "AUTO" } });
    // 캡처가 실패하도록 GameState 행을 지운다 (세계관·런타임은 그대로)
    await prisma.gameState.delete({ where: { worldId: world.id } });
    expect(await runAutoSave(world.id, at(2 * H))).toBe("skipped");
    expect((await runtime(world.id)).nextAutoSaveAt).toEqual(new Date(at(2 * H).getTime() + AUTO_SAVE_RETRY_MS));
    expect((await prisma.saveGame.findUniqueOrThrow({ where: { id: saved.id } })).snapshotId).toBe(saved.snapshotId);
  });
});

describe("불러오기", () => {
  it("감정·관계·기억·대화·설정을 저장 시점으로 원자적으로 되돌리고, 이후 만든 캐릭터·장면은 남지 않는다", async () => {
    const { uid, world, chars, deps } = await setup("save-load");
    await generateScene(uid, world.id, deps);
    const saved = await createManualSave(uid, world.id, "첫 장면 뒤");
    const expected = await current(world.id);

    await generateScene(uid, world.id, deps);
    await updateCharacter(uid, world.id, chars[0]!.id, renamed("바뀐 이름"));
    await prisma.character.create({ data: characterData(world.id, "새 인물") });
    const versionBefore = (await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } })).stateVersion;

    await loadSave(uid, world.id, saved.id);
    const restored = await current(world.id);
    expect({ ...restored, capturedAt: null }).toEqual({ ...expected, capturedAt: null });
    expect(await prisma.characterMemory.count({ where: { worldId: world.id } })).toBe(1);
    expect((await prisma.gameState.findUniqueOrThrow({ where: { worldId: world.id } })).stateVersion).toBe(versionBefore + 1);
    expect(await runtime(world.id)).toMatchObject({ status: "IDLE", statusReason: "LOADED", currentRunId: null, leaseOwner: null, inFlightAttemptId: null });
    const types = (await prisma.simulationEvent.findMany({ where: { worldId: world.id }, orderBy: { id: "desc" }, take: 3 })).map((e) => e.type);
    expect(types.sort()).toEqual(["runtime.status", "saves.updated", "state.replaced"]);
    // 이어서 장면을 만들면 저장 시점 다음 번호부터
    expect((await generateScene(uid, world.id, deps)).seq).toBe(2);
  });

  it("RUNNING·PAUSING·PAUSED·진행 중 시도에서는 거부하고, 불러오기 전 시작된 시도의 늦은 결과는 저장되지 않는다", async () => {
    const { uid, world, deps } = await setup("save-block", { generateText: SCENE, delayMs: 300 });
    const saved = await createManualSave(uid, world.id, "처음");
    await runSimulationCommand(uid, world.id, "start");
    await expect(loadSave(uid, world.id, saved.id)).rejects.toMatchObject({ status: 409, code: "LOAD_REQUIRES_IDLE" });
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { status: "PAUSING" } });
    await expect(loadSave(uid, world.id, saved.id)).rejects.toMatchObject({ code: "LOAD_REQUIRES_IDLE" });
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { status: "PAUSED" } });
    await expect(loadSave(uid, world.id, saved.id)).rejects.toMatchObject({ code: "LOAD_REQUIRES_IDLE" });
    await runSimulationCommand(uid, world.id, "stop");
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { inFlightAttemptId: "x", inFlightStartedAt: new Date() } });
    await expect(loadSave(uid, world.id, saved.id)).rejects.toMatchObject({ code: "LOAD_REQUIRES_IDLE" });
    await prisma.simulationRuntime.update({ where: { worldId: world.id }, data: { inFlightAttemptId: null, inFlightStartedAt: null } });

    // 불러오기 전에 시작된 시도(점유 없이 진행 중) → 불러오기가 stateVersion을 올려 커밋을 막는다
    const prepared = await prepareScene(uid, world.id, deps);
    const late = runSceneAttempt(uid, world.id, prepared, { attemptId: "late-attempt" }, deps);
    await loadSave(uid, world.id, saved.id);
    await expect(late).rejects.toMatchObject({ code: "SCENE_STALE" });
    expect(await prisma.conversationScene.count({ where: { worldId: world.id } })).toBe(0);
    expect(await prisma.characterMemory.count({ where: { worldId: world.id } })).toBe(0);
  });

  it("손상·새 버전 스냅샷은 거부하고, 적용 중 실패하면 현재 상태와 복구 지점을 모두 되돌린다", async () => {
    const { uid, world, chars, deps } = await setup("save-invalid");
    const other = await setup("save-invalid-other");
    await generateScene(uid, world.id, deps);
    const valid = await createManualSave(uid, world.id, "정상");
    const row = await prisma.gameSnapshot.findFirstOrThrow({ where: { save: { id: valid.id } } });
    expect(() => parseSnapshot({ ...row, checksum: "0".repeat(64) })).toThrow(expect.objectContaining({ code: "SAVE_INVALID" }));
    expect(() => parseSnapshot({ ...row, schemaVersion: 99 })).toThrow(expect.objectContaining({ code: "SAVE_INVALID" }));

    // 참조는 맞지만 다른 세계관의 캐릭터 ID를 쓰는 스냅샷 → 적용 중 거부 → 전체 롤백
    const forged = JSON.parse(JSON.stringify(row.payload).replaceAll(chars[0]!.id, other.chars[0]!.id)) as object;
    const snap = await prisma.gameSnapshot.create({ data: { worldId: world.id, schemaVersion: 1, payload: forged, ...snapshotChecksum(forged) } });
    const bad = await prisma.saveGame.create({
      data: { worldId: world.id, kind: "MANUAL", name: "위조", snapshotId: snap.id, sceneCount: 1, characterCount: 2, worldNameSnapshot: "w", stateVersionAtSave: 0 },
    });
    const before = await current(world.id);
    const recoveryBefore = await recoveryRow(world.id);
    await expect(loadSave(uid, world.id, bad.id)).rejects.toMatchObject({ code: "SAVE_INVALID" });
    expect({ ...(await current(world.id)), capturedAt: null }).toEqual({ ...before, capturedAt: null });
    expect((await recoveryRow(world.id)).snapshotId).toBe(recoveryBefore.snapshotId);
    expect(await prisma.character.findUniqueOrThrow({ where: { id: other.chars[0]!.id } })).toMatchObject({ worldId: other.world.id, name: "가람" });
  });

  it("복구 지점: 직전 상태를 보관하고, 변경 없이 연속으로 불러오면 유지, 변경 후에는 교체, 복구 지점을 불러오면 현재 상태와 맞바꾼다", async () => {
    const { uid, world, chars, deps } = await setup("save-recovery");
    const a = await createManualSave(uid, world.id, "A (장면 0)");
    await generateScene(uid, world.id, deps);
    const b = await createManualSave(uid, world.id, "B (장면 1)");
    await generateScene(uid, world.id, deps); // 진행 상태 P = 장면 2개

    await loadSave(uid, world.id, a.id);
    const first = await recoveryRow(world.id);
    expect(first.sceneCount).toBe(2); // P 보관
    await loadSave(uid, world.id, b.id); // 변경 없이 연속 불러오기 → 최초 복구 지점 유지
    expect((await recoveryRow(world.id)).snapshotId).toBe(first.snapshotId);
    expect((await listSaves(uid, world.id)).saves).toHaveLength(2); // 복구 지점은 목록에 없다

    await updateCharacter(uid, world.id, chars[0]!.id, renamed("B 이후 수정")); // changeSeq 증가
    await loadSave(uid, world.id, a.id);
    const replaced = await recoveryRow(world.id);
    expect(replaced.snapshotId).not.toBe(first.snapshotId);
    expect(replaced).toMatchObject({ sceneCount: 1 });

    // 복구 지점 불러오기 → "B 이후 수정" 상태로 돌아가고, 복구 지점은 방금의 A 상태가 된다
    await loadSave(uid, world.id, replaced.id);
    expect((await prisma.character.findUniqueOrThrow({ where: { id: chars[0]!.id } })).name).toBe("B 이후 수정");
    expect(await recoveryRow(world.id)).toMatchObject({ sceneCount: 0 });
    expect(await prisma.saveGame.count({ where: { worldId: world.id, kind: "RECOVERY" } })).toBe(1);
  });
});
