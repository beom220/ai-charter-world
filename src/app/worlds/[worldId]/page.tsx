import { Suspense } from "react";
import { LoadingFallback } from "@/app/loading-fallback";
import { notFound } from "next/navigation";
import { getCurrentSession } from "@/server/auth/session";
import { listCharacters } from "@/server/domain/characters/characters";
import { NotFoundError } from "@/server/domain/errors";
import { asAuthenticatedUserId } from "@/server/domain/identity";
import { listSaves } from "@/server/domain/saves/saves";
import { listScenes } from "@/server/domain/scenes/generate-scene";
import { getSimulationState } from "@/server/domain/simulation/control";
import { getWorld } from "@/server/domain/worlds";
import { worldStartDate } from "@/lib/world-clock";
import { currentWorldEventCursor } from "@/server/events/world-stream";
import { loadButton, LoginRequired, saveButton } from "../ui";
import { SaveControls } from "./save-panel";
import { ScenePanel, type SceneItem } from "./scene-panel";

// 대화 탭 (/worlds/[worldId], 세계관 진입 시 기본 화면). 대화 장면·실시간 말풍선, 실행 제어·속도, 저장·불러오기.
// 캐릭터는 /characters, 세계관 설정은 /settings 탭으로 분리했다. 없거나 타인 소유이면 404.
// 이 화면을 떠나면(탭 이동·다른 페이지·언마운트) 대화 패널이 서버에 알리고, 남은 대화 화면 연결이 없으면 일시정지된다.

// cacheComponents: 세션·params·DB를 읽는 부분은 페이지 안의 Suspense 경계에 둔다 (탐색·프리렌더 시 uncached data 오류 방지)
export default function WorldConversationPage({ params }: PageProps<"/worlds/[worldId]">) {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <WorldConversation params={params} />
    </Suspense>
  );
}

async function WorldConversation({ params }: { params: PageProps<"/worlds/[worldId]">["params"] }) {
  const session = await getCurrentSession();
  if (!session) return <LoginRequired />;
  const { worldId } = await params;

  const userId = asAuthenticatedUserId(session.user.id);
  let world, characters, scenes, eventCursor, simulation, saves;
  try {
    // 커서를 먼저 읽는다: 이후에 커밋된 장면·상태 변경은 SSE로 다시 온다(장면은 id로 중복을 거르고, 상태는 마지막 것이 이긴다)
    eventCursor = await currentWorldEventCursor(userId, worldId);
    [world, characters, scenes, simulation, saves] = await Promise.all([
      getWorld(userId, worldId),
      listCharacters(userId, worldId),
      listScenes(userId, worldId),
      getSimulationState(userId, worldId),
      listSaves(userId, worldId),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  return (
    <ScenePanel
      key={`scene-${saves.replaceMarker}`} // 불러오기 뒤에는 새로 마운트해 이전 장면·재생 상태를 버린다
      worldId={worldId}
      worldStartDate={worldStartDate(world.createdAt)}
      activeCharacters={characters.map((c) => ({ id: c.id, alive: c.condition.vital === "ALIVE", avatarId: c.avatarId }))}
      initialScenes={JSON.parse(JSON.stringify(scenes.scenes)) as SceneItem[]}
      initialHasMore={scenes.hasMore}
      eventCursor={eventCursor}
      initialState={simulation}
      saveControls={<SaveControls key={`saves-${saves.replaceMarker}`} worldId={worldId} initial={saves} saveClass={saveButton} loadClass={loadButton} />}
    />
  );
}
