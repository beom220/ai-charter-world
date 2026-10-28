// RunnerHost 신호 (architecture.md §7.2·§7.7). 런타임 독립.
// 제어 명령은 DB 상태를 바꾼 뒤 signalRunner(worldId)만 부른다. 같은 프로세스에 RunnerHost가 없으면 아무것도 하지 않는다
// (테스트·Runner 비활성). 신호는 힌트일 뿐이고, 유실되어도 Runner 폴링과 복구 스위퍼가 DB 상태로 따라잡는다.
// host.ts를 import하지 않아 control → host → tick → control 순환을 만들지 않는다.

export interface RunnerSignalTarget {
  signal(worldId: string): void;
}

const slot = globalThis as { __runnerHost?: RunnerSignalTarget };

export function registerRunnerHost(host: RunnerSignalTarget | undefined): void {
  slot.__runnerHost = host;
}

export function signalRunner(worldId: string): void {
  slot.__runnerHost?.signal(worldId);
}
