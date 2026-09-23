// A pulsing placeholder block, shaped to whatever it's standing in for
// via width/height/radius props. Used while the initial data load is in
// flight (see App.jsx) so the app shows its actual layout taking shape
// rather than a blank screen with a loading message - the same trick
// native apps and most polished web apps use instead of a spinner.
export default function Skeleton({ width = "100%", height = 16, radius = 8, className = "", style = {} }) {
  return (
    <div
      className={`fd-skeleton ${className}`}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}
