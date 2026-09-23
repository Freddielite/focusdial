import Skeleton from "./Skeleton.jsx";

// Mirrors TodayView's actual shape (goal/streak card, Plan/Reflect
// buttons, a suggestion banner, the timer, then a few task rows) so the
// real content doesn't pop in and shove things around once it arrives -
// the skeleton already occupies roughly the space each piece will need.
export default function TodaySkeleton() {
  return (
    <div className="fd-skeleton-today">
      <Skeleton height={90} radius={16} />
      <div className="fd-skeleton-today__row">
        <Skeleton height={38} radius={12} />
        <Skeleton height={38} radius={12} />
      </div>
      <Skeleton height={64} radius={14} />
      <Skeleton height={140} radius={18} />
      <Skeleton height={20} width="40%" radius={6} />
      <Skeleton height={52} radius={12} />
      <Skeleton height={52} radius={12} />
      <Skeleton height={52} radius={12} />
    </div>
  );
}
