import { barFill, type BarView } from "@/lib/character-status";

// 상태창 공통 양극형 막대 (관계·감정·신체 상태). 중앙 0, 왼쪽 끝 -100, 오른쪽 끝 +100.
// 채움(primary-soft)·빈 바탕(bar-track)·중앙 기준선(primary-strong)은 모든 막대가 같고, 의미는 방향과 문구로 구분한다.
// - 기본(row): [라벨 | 막대 | 문구] 한 줄 (관계 카드)
// - stacked: 라벨과 문구를 한 줄에, 막대는 그 아래 전체 폭 (현재 상태 카드)
// 화면 낭독기에는 막대가 문구(aria-valuetext)로 읽힌다.

function Bipolar({ bar }: { bar: BarView }) {
  const fill = barFill(bar.value);
  return (
    <span role="meter" aria-valuemin={-100} aria-valuemax={100} aria-valuenow={bar.value} aria-valuetext={bar.text} className="relative flex h-3.5 min-w-0 flex-1 items-center">
      <span className="relative h-2.5 w-full overflow-hidden rounded-full bg-bar-track">
        {fill.side && (
          <span
            className={`absolute inset-y-0 bg-primary-soft ${fill.side === "left" ? "right-1/2 rounded-l-full" : "left-1/2 rounded-r-full"}`}
            style={{ width: `${fill.widthPercent}%` }}
          />
        )}
      </span>
      <span aria-hidden className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-primary-strong" />
    </span>
  );
}

export function StatusBar({
  label,
  bar,
  detail,
  stacked = false,
}: {
  label: React.ReactNode;
  bar: BarView;
  detail?: string | null;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="min-w-0 truncate font-semibold">{label}</span>
          <span className="shrink-0 text-xs font-medium text-foreground/70">{bar.text}</span>
        </div>
        <Bipolar bar={bar} />
        {detail && <p className="text-xs break-words text-foreground/60">{detail}</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3 text-sm">
        <span className="flex w-24 shrink-0 items-center truncate text-foreground/80 sm:w-28">{label}</span>
        <Bipolar bar={bar} />
        <span className="w-16 shrink-0 text-right text-xs font-medium sm:w-20">{bar.text}</span>
      </div>
      {detail && <p className="pl-[6.75rem] text-xs break-words text-foreground/60 sm:pl-[7.75rem]">{detail}</p>}
    </div>
  );
}
