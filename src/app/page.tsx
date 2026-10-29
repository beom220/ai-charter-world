import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
      <h1 className="text-2xl font-semibold">AI Character World</h1>
      <p className="text-sm text-foreground/70">나만의 세계관과 캐릭터가 자율적으로 대화합니다.</p>
      <Link href="/worlds" className="text-sm text-primary-strong underline">
        내 세계관으로 이동
      </Link>
    </main>
  );
}
