// The brand mark: a camera autofocus reticle — four corner brackets
// around a center focus point. Replaces the old half-dial glyph
// everywhere it appeared (header, toast/notification default icon), so
// there's one definition instead of copy-pasted SVG paths drifting out
// of sync.
export default function FocusMark({ size = 20, strokeWidth = 2.2, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M8 4H5a1 1 0 0 0-1 1v3" />
      <path d="M16 4h3a1 1 0 0 1 1 1v3" />
      <path d="M4 16v3a1 1 0 0 0 1 1h3" />
      <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
