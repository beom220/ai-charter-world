// 페이지 로딩 표시 (Suspense fallback 공용). "불러오는 중…" 문구 대신 화면 모양의 회색 틀(스켈레톤)을 보인다.
// 서버 응답은 보통 0.1~0.2초라 바로 보이면 깜박임만 남으므로, 0.3초가 지나도 아직 로딩 중일 때만 서서히 나타난다(loading-delayed).
// 화면 낭독기에는 "불러오는 중"으로 읽힌다.

export function LoadingFallback() {
  return (
    <div role="status" aria-live="polite" className="loading-delayed flex flex-col gap-4">
      <span className="sr-only">불러오는 중</span>
      <div aria-hidden className="flex items-center gap-4">
        <span className="h-14 w-14 shrink-0 animate-pulse rounded-full bg-foreground/10" />
        <span className="flex flex-1 flex-col gap-2">
          <span className="h-5 w-1/3 animate-pulse rounded bg-foreground/10" />
          <span className="h-3.5 w-1/2 animate-pulse rounded bg-foreground/10" />
        </span>
      </div>
      <span aria-hidden className="h-24 animate-pulse rounded-md bg-foreground/[0.06]" />
      <span aria-hidden className="h-40 animate-pulse rounded-md bg-foreground/[0.06]" />
    </div>
  );
}
