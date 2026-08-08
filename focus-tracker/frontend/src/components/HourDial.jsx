import { formatDuration, formatHour } from "../format.js";

const SIZE = 260;
const MARGIN = 28;
const VIEWBOX = SIZE + MARGIN * 2;
const CENTER = VIEWBOX / 2;
const OUTER_R = 108;
const INNER_R = 44;

// Converts an hour (0-23) to an angle, with midnight at the top and hours
// running clockwise — reads like a 24-hour clock face, not a math
// convention (0 radians = 3 o'clock) that would put midnight on the side.
function hourToAngle(hour) {
  return (hour / 24) * 360 - 90;
}

function polarPoint(radius, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CENTER + radius * Math.cos(rad), y: CENTER + radius * Math.sin(rad) };
}

function wedgePath(hour, radius) {
  const start = hourToAngle(hour) - 7.5;
  const end = hourToAngle(hour) + 7.5;
  const outerStart = polarPoint(radius, start);
  const outerEnd = polarPoint(radius, end);
  const innerStart = polarPoint(INNER_R, start);
  const innerEnd = polarPoint(INNER_R, end);
  return `M ${innerStart.x} ${innerStart.y} L ${outerStart.x} ${outerStart.y} A ${radius} ${radius} 0 0 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${INNER_R} ${INNER_R} 0 0 0 ${innerStart.x} ${innerStart.y} Z`;
}

export default function HourDial({ hourly, bestHour }) {
  const maxSeconds = Math.max(...hourly.map((h) => h.seconds), 1);

  return (
    <div className="fd-panel fd-dial-panel">
      <div className="fd-panel__label">Your Best Hours</div>
      <svg viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} className="fd-dial" role="img" aria-label="Focus intensity by hour of day">
        <circle cx={CENTER} cy={CENTER} r={OUTER_R + 6} fill="none" stroke="var(--line)" strokeWidth="1" />
        <circle cx={CENTER} cy={CENTER} r={INNER_R - 2} fill="none" stroke="var(--line)" strokeWidth="1" />
        {hourly.map((h) => {
          const intensity = h.seconds / maxSeconds;
          const radius = INNER_R + intensity * (OUTER_R - INNER_R);
          const isBest = h.hour === bestHour.hour && bestHour.seconds > 0;
          return (
            <path
              key={h.hour}
              d={wedgePath(h.hour, Math.max(radius, INNER_R + 2))}
              fill={isBest ? "var(--focus-green)" : "var(--brass)"}
              opacity={h.seconds === 0 ? 0.08 : 0.35 + intensity * 0.55}
            />
          );
        })}
        {[0, 6, 12, 18].map((hour) => {
          const { x, y } = polarPoint(OUTER_R + 20, hourToAngle(hour));
          return (
            <text key={hour} x={x} y={y} className="fd-dial-label" textAnchor="middle" dominantBaseline="middle">
              {formatHour(hour)}
            </text>
          );
        })}
        <text x={CENTER} y={CENTER - 6} textAnchor="middle" className="fd-dial-center-label">
          Peak
        </text>
        <text x={CENTER} y={CENTER + 14} textAnchor="middle" className="fd-dial-center-value">
          {bestHour.seconds > 0 ? formatHour(bestHour.hour) : "N/A"}
        </text>
      </svg>
      <div className="fd-dial-caption">
        {bestHour.seconds > 0
          ? `You've logged the most focus time historically starting around ${formatHour(bestHour.hour)} (${formatDuration(bestHour.seconds)} total).`
          : "Log a few sessions to see your peak focus hours."}
      </div>
    </div>
  );
}
