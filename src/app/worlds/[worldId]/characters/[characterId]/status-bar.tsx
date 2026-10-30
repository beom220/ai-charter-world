import type { StatusBarView } from "@/lib/character-status";

// 상태창 공통 칸 막대 (관계·감정 강도·신체 상태). 둥근 칸을 단계만큼 채우고 오른쪽에 상태 문구를 함께 보인다.
// 화면 낭독기에는 "라벨: 문구 (n/전체단계)"로 읽힌다.

export function StatusBar({ label, bar, icon, detail }: { label: React.ReactNode; bar: StatusBarView; icon?: string; detail?: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3 text-sm">
        <span className="flex w-24 shrink-0 items-center gap-1.5 truncate text-foreground/80 sm:w-28">
          {icon && <span aria-hidden>{icon}</span>}
          {label}
        </span>
        <span
          role="meter"
          aria-valuemin={0}
          aria-valuemax={bar.segments}
          aria-valuenow={bar.filled}
          aria-valuetext={bar.text}
          className="flex min-w-0 flex-1 gap-1"
        >
          {Array.from({ length: bar.segments }, (_, i) => (
            <span
              key={i}
              className="h-2.5 flex-1 rounded-full bg-foreground/10"
              style={i < bar.filled ? { backgroundColor: bar.color } : undefined}
            />
          ))}
        </span>
        <span className="w-16 shrink-0 text-right text-xs font-medium sm:w-20">{bar.text}</span>
      </div>
      {detail && <p className="pl-[6.75rem] text-xs text-foreground/60 break-words sm:pl-[7.75rem]">{detail}</p>}
    </div>
  );
}
