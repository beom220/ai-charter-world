import type { StatusBarView } from "@/lib/character-status";

// 상태창 공통 칸 막대 (관계·감정 강도·신체 상태). 둥근 칸을 단계만큼 채우고 상태 문구를 함께 보인다.
// - 기본(row): [라벨 | 막대 | 문구] 한 줄 (관계 카드)
// - stacked: 라벨과 문구를 한 줄에, 막대는 그 아래 전체 폭 (현재 상태 카드)
// 화면 낭독기에는 막대가 "문구 (n/전체단계)"로 읽힌다.

function Segments({ bar }: { bar: StatusBarView }) {
  return (
    <span role="meter" aria-valuemin={0} aria-valuemax={bar.segments} aria-valuenow={bar.filled} aria-valuetext={bar.text} className="flex min-w-0 flex-1 gap-1">
      {Array.from({ length: bar.segments }, (_, i) => (
        <span key={i} className="h-2.5 flex-1 rounded-full bg-foreground/10" style={i < bar.filled ? { backgroundColor: bar.color } : undefined} />
      ))}
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
  bar: StatusBarView;
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
        <Segments bar={bar} />
        {detail && <p className="text-xs break-words text-foreground/60">{detail}</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3 text-sm">
        <span className="flex w-24 shrink-0 items-center truncate text-foreground/80 sm:w-28">{label}</span>
        <Segments bar={bar} />
        <span className="w-16 shrink-0 text-right text-xs font-medium sm:w-20">{bar.text}</span>
      </div>
      {detail && <p className="pl-[6.75rem] text-xs break-words text-foreground/60 sm:pl-[7.75rem]">{detail}</p>}
    </div>
  );
}
