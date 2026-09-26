// Reminders and deadlines otherwise only show as "due" on their own
// tabs (Reminders/Deadlines), which most people don't visit unless
// something already reminded them to. This surfaces the same "due"
// concept - reusing the exact same rules those tabs already use, not a
// third slightly-different definition - right on the Today screen,
// which people actually open.
//
// Rendered as a compact strip of chips inside HeroCard rather than its
// own separate card - Today was stacking up to 7 cards before the
// timer even showed up, and a whole extra bordered panel just for this
// made that worse, not better. A chip row costs one line, not a card.
// Tapping a chip jumps to the real tab to act on it (dismiss, complete,
// etc.) rather than re-implementing those actions a second time here.
function BellIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

// Same flag glyph TasksWidget uses for a task created from a deadline,
// so the two read as the same kind of thing here too.
function FlagIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3v18" />
      <path d="M6 4h11l-2 3 2 3H6" />
    </svg>
  );
}

export default function DueTodayBanner({ reminders, deadlines, onNavigateTab }) {
  const now = new Date();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  // Same "due" rule RemindersView's own due/upcoming split already uses
  // - the backend only ever sends pending (not yet dismissed/converted)
  // reminders in the first place, so remind_at <= now is the whole check.
  const dueReminders = reminders.filter((r) => new Date(r.remind_at) <= now);

  // Same active-status rule DeadlinesView's own list already uses, plus
  // "due" here means overdue OR due before today ends - not just
  // already-overdue, so a deadline due later today shows up before it's
  // too late to act on it, not after.
  const dueDeadlines = deadlines.filter(
    (d) => d.status !== "done" && d.status !== "archived" && d.dueAt <= endOfToday
  );

  if (dueReminders.length === 0 && dueDeadlines.length === 0) return null;

  const items = [
    ...dueReminders.map((r) => ({ kind: "reminder", id: r.id, title: r.title, sortAt: new Date(r.remind_at) })),
    ...dueDeadlines.map((d) => ({ kind: "deadline", id: d.id, title: d.title, sortAt: d.dueAt })),
  ].sort((a, b) => a.sortAt - b.sortAt);

  return (
    <div className="fd-hero__due-strip">
      {items.map((item) => (
        <button
          key={`${item.kind}-${item.id}`}
          type="button"
          className={`fd-hero__due-chip fd-hero__due-chip--${item.kind}`}
          onClick={() => onNavigateTab(item.kind === "reminder" ? "reminders" : "deadlines")}
        >
          {item.kind === "reminder" ? <BellIcon /> : <FlagIcon />}
          <span className="fd-hero__due-chip-title">{item.title}</span>
        </button>
      ))}
    </div>
  );
}
