export default function OverviewGrid({ cards }) {
  return (
    <section className={`grid gap-4 md:grid-cols-2 ${cards.length % 3 === 0 && cards.length % 4 !== 0 ? "xl:grid-cols-3" : "xl:grid-cols-4"}`}>
      {cards.map((card) => (
        <article
          key={card.label}
          className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-5 shadow-[0_12px_40px_rgba(0,0,0,0.24)]"
        >
          <p className="text-sm uppercase tracking-[0.2em] text-[var(--muted)]">{card.label}</p>
          <div className="mt-4 flex items-end justify-between gap-4">
            <p className="text-3xl font-semibold text-white">{card.value}</p>
            <span className="rounded-full bg-white/5 px-3 py-1 text-xs font-medium text-[var(--accent)]">
              {card.note}
            </span>
          </div>
        </article>
      ))}
    </section>
  );
}
