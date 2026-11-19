"use client";

import { useRef, type KeyboardEvent } from "react";

import { cn } from "@/components/ui/cn";
import { SUSPENSION_ZONES, ZONE_LABEL, type SuspensionZone } from "@/lib/suspension/types";

/**
 * SledWerx suspension map: an original top-down line drawing of a snowmobile
 * (nose up, so the sled's left is on the left), drawn like a workshop
 * blueprint. Seven numbered markers select a zone; they are real buttons
 * (44 px, keyboard and screen-reader friendly, arrow keys move between them).
 * The artwork itself is decorative; the zone list next to it is the
 * plain-text alternative.
 */

const W = 520;
const H = 900;

/** Marker position (SVG units) and the point its leader line points at. */
const MARKERS: Record<SuspensionZone, { x: number; y: number; to: [number, number] }> = {
  front_left_shock: { x: 42, y: 236, to: [150, 168] },
  front_right_shock: { x: 478, y: 236, to: [370, 168] },
  front_general: { x: 260, y: 178, to: [260, 178] },
  rear_front_shock: { x: 446, y: 470, to: [272, 478] },
  rear_springs_limiter: { x: 74, y: 640, to: [204, 642] },
  rear_rear_shock: { x: 446, y: 668, to: [272, 668] },
  rear_general: { x: 74, y: 830, to: [214, 830] },
};

export const ZONE_NUMBER: Record<SuspensionZone, number> = Object.fromEntries(SUSPENSION_ZONES.map((zone, n) => [zone, n + 1])) as Record<
  SuspensionZone,
  number
>;

const ink = "rgba(245,247,250,0.62)";
const faint = "rgba(245,247,250,0.28)";
const hidden = "rgba(245,247,250,0.4)";
const hot = "var(--accent-hot)";

function zoneStroke(active: boolean, base = ink) {
  return active ? hot : base;
}

/** A coil-over shock drawn along the x axis from 0 to `length` (place it with a transform). */
function Shock({ length, active, dashed = false }: { length: number; active: boolean; dashed?: boolean }) {
  const body = length * 0.52;
  const coils = 7;
  const coilStart = 8;
  const coilEnd = length - 10;
  const step = (coilEnd - coilStart) / coils;
  let d = `M ${coilStart} -12`;
  for (let n = 0; n < coils; n++) {
    const x = coilStart + step * n;
    d += ` L ${x + step / 2} 12 L ${x + step} -12`;
  }
  const stroke = zoneStroke(active, dashed ? hidden : ink);
  return (
    <g
      fill="none"
      stroke={stroke}
      strokeWidth={active ? 2.6 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={dashed && !active ? "5 4" : undefined}
    >
      {active ? <rect x={-6} y={-20} width={length + 12} height={40} rx={20} fill="rgba(255,122,26,0.14)" stroke="none" /> : null}
      <rect x={2} y={-7} width={body} height={14} rx={4} fill={active ? "rgba(255,122,26,0.18)" : "rgba(11,13,16,0.9)"} />
      <line x1={body} y1={0} x2={length - 4} y2={0} strokeWidth={active ? 3 : 2.2} />
      <path d={d} strokeWidth={active ? 2 : 1.4} />
      <circle cx={0} cy={0} r={5} fill="rgba(11,13,16,1)" />
      <circle cx={length} cy={0} r={5} fill="rgba(11,13,16,1)" />
    </g>
  );
}

/** One front corner: ski, spindle, A-arms and shock. Drawn for the left; mirrored for the right. */
function FrontCorner({ mirror, shockActive, frontActive }: { mirror: boolean; shockActive: boolean; frontActive: boolean }) {
  const arm = zoneStroke(frontActive);
  return (
    <g transform={mirror ? `translate(${W} 0) scale(-1 1)` : undefined}>
      {/* Ski */}
      <path
        d="M 82 336 L 82 78 C 82 46 88 30 96 26 C 104 30 110 46 110 78 L 110 336 C 102 344 90 344 82 336 Z"
        fill="rgba(20,23,28,0.95)"
        stroke={ink}
        strokeWidth={1.8}
      />
      <line x1={96} y1={70} x2={96} y2={326} stroke={faint} strokeWidth={1.2} strokeDasharray="10 6" />
      <path d="M 88 300 L 104 300 M 88 310 L 104 310" stroke={faint} strokeWidth={1.2} />
      {/* Spindle */}
      <rect x={100} y={160} width={18} height={44} rx={5} fill="rgba(11,13,16,1)" stroke={arm} strokeWidth={1.8} />
      {/* A-arms */}
      <g stroke={arm} strokeWidth={frontActive ? 3 : 2.2} strokeLinecap="round" fill="none">
        <path d="M 118 168 L 196 136 M 118 168 L 196 176" />
        <path d="M 118 196 L 198 196 M 118 196 L 198 232" />
      </g>
      {frontActive ? <circle cx={160} cy={190} r={52} fill="rgba(255,122,26,0.08)" /> : null}
      {/* Shock: lower A-arm to the upper mount on the bulkhead */}
      <g transform="translate(136 196) rotate(-58)">
        <Shock length={102} active={shockActive} />
      </g>
    </g>
  );
}

/** The decorative artwork (no interaction). */
function Artwork({ selected }: { selected: SuspensionZone | null }) {
  const is = (zone: SuspensionZone) => selected === zone;
  const springs = is("rear_springs_limiter");
  const rear = is("rear_general");
  const front = is("front_general");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden focusable="false">
      <defs>
        <pattern id="sw-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(245,247,250,0.045)" strokeWidth="1" />
        </pattern>
        <pattern id="sw-grid-major" width="100" height="100" patternUnits="userSpaceOnUse">
          <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(245,247,250,0.07)" strokeWidth="1" />
        </pattern>
        <pattern id="sw-tread" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="10" stroke="rgba(245,247,250,0.12)" strokeWidth="3" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#sw-grid)" />
      <rect width={W} height={H} fill="url(#sw-grid-major)" />

      {/* Center line */}
      <line x1={260} y1={8} x2={260} y2={892} stroke="rgba(245,247,250,0.08)" strokeWidth={1} strokeDasharray="18 6 4 6" />

      {/* Front suspension (under the hood) */}
      <FrontCorner mirror={false} shockActive={is("front_left_shock")} frontActive={front} />
      <FrontCorner mirror shockActive={is("front_right_shock")} frontActive={front} />

      {/* Steering: post and tie rods */}
      <g stroke={zoneStroke(front, faint)} strokeWidth={front ? 2.4 : 1.6} fill="none" strokeLinecap="round">
        <path d="M 260 214 L 260 312" />
        <path d="M 120 214 L 260 222 L 400 214" />
      </g>

      {/* Hood and bodywork */}
      <path
        d="M 260 40 C 300 44 326 72 338 116 L 350 252 L 170 252 L 182 116 C 194 72 220 44 260 40 Z"
        fill="rgba(20,23,28,0.82)"
        stroke={zoneStroke(front)}
        strokeWidth={front ? 2.6 : 1.9}
      />
      <path d="M 226 70 L 246 58 M 294 70 L 274 58" stroke={faint} strokeWidth={4} strokeLinecap="round" />
      <path d="M 214 132 L 306 132 M 206 196 L 314 196" stroke={faint} strokeWidth={1.2} strokeDasharray="3 5" />
      {/* Windshield */}
      <path d="M 172 258 Q 260 232 348 258 L 338 294 Q 260 276 182 294 Z" fill="rgba(245,247,250,0.06)" stroke={ink} strokeWidth={1.6} />
      {/* Handlebar */}
      <g stroke={ink} strokeWidth={2.4} strokeLinecap="round" fill="none">
        <path d="M 162 322 L 214 316 L 260 306 L 306 316 L 358 322" />
      </g>
      <rect x={140} y={315} width={26} height={12} rx={5} fill="rgba(11,13,16,1)" stroke={ink} strokeWidth={1.6} />
      <rect x={354} y={315} width={26} height={12} rx={5} fill="rgba(11,13,16,1)" stroke={ink} strokeWidth={1.6} />

      {/* Running boards */}
      <rect x={148} y={330} width={50} height={300} rx={8} fill="url(#sw-tread)" stroke={ink} strokeWidth={1.6} />
      <rect x={322} y={330} width={50} height={300} rx={8} fill="url(#sw-tread)" stroke={ink} strokeWidth={1.6} />

      {/* Tunnel (the skid below is drawn dashed: it's hidden under it) */}
      <path
        d="M 198 300 L 322 300 L 322 852 Q 322 866 308 866 L 212 866 Q 198 866 198 852 Z"
        fill="rgba(20,23,28,0.9)"
        stroke={ink}
        strokeWidth={1.9}
      />

      {/* Skid rails and arms (hidden lines) */}
      <g stroke={hidden} strokeWidth={1.5} strokeDasharray="6 5" fill="none">
        <path d="M 222 402 L 222 848 M 298 402 L 298 848" />
        <path d="M 214 432 L 306 432 M 214 642 L 306 642" />
      </g>
      {/* Rear: idler wheels, rear axle and track end */}
      <g stroke={zoneStroke(rear, hidden)} strokeWidth={rear ? 2.4 : 1.5} strokeDasharray={rear ? undefined : "6 5"} fill="none">
        <circle cx={222} cy={828} r={16} />
        <circle cx={298} cy={828} r={16} />
        <path d="M 206 828 L 314 828" />
      </g>
      {rear ? <rect x={196} y={790} width={128} height={78} rx={14} fill="rgba(255,122,26,0.12)" /> : null}

      {/* Front and rear track shocks, along the center line */}
      <g transform="translate(260 418) rotate(90)">
        <Shock length={128} active={is("rear_front_shock")} dashed />
      </g>
      <g transform="translate(260 604) rotate(90)">
        <Shock length={128} active={is("rear_rear_shock")} dashed />
      </g>

      {/* Torsion springs on both sides of the rear arm, and the limiter strap */}
      <g stroke={zoneStroke(springs, hidden)} strokeWidth={springs ? 2.4 : 1.5} fill="none" strokeDasharray={springs ? undefined : "4 4"}>
        {[206, 314].map((cx) => (
          <g key={cx}>
            <circle cx={cx} cy={642} r={13} />
            <circle cx={cx} cy={642} r={7} />
            <path d={`M ${cx} 655 L ${cx === 206 ? cx + 6 : cx - 6} 760`} />
          </g>
        ))}
        <rect x={232} y={386} width={10} height={40} rx={4} />
        <path d="M 237 394 L 237 396 M 237 404 L 237 406 M 237 414 L 237 416" strokeWidth={3} strokeLinecap="round" />
      </g>
      {springs ? (
        <g fill="rgba(255,122,26,0.12)">
          <circle cx={206} cy={642} r={26} />
          <circle cx={314} cy={642} r={26} />
          <rect x={222} y={378} width={30} height={56} rx={10} />
        </g>
      ) : null}

      {/* Seat */}
      <rect x={214} y={332} width={92} height={236} rx={30} fill="rgba(11,13,16,0.55)" stroke={ink} strokeWidth={1.6} />
      <path d="M 226 360 L 226 540 M 294 360 L 294 540" stroke={faint} strokeWidth={1} strokeDasharray="2 4" />

      {/* Rear bumper and snow flap */}
      <path d="M 192 866 L 192 880 L 328 880 L 328 866" fill="none" stroke={ink} strokeWidth={2.2} strokeLinejoin="round" />
      <rect x={220} y={882} width={80} height={10} rx={2} fill="rgba(245,247,250,0.1)" stroke={faint} strokeWidth={1} />

      {/* Leader lines from the markers */}
      {SUSPENSION_ZONES.map((zone) => {
        const m = MARKERS[zone];
        if (m.to[0] === m.x && m.to[1] === m.y) return null;
        const active = is(zone);
        return (
          <g key={zone}>
            <line
              x1={m.x}
              y1={m.y}
              x2={m.to[0]}
              y2={m.to[1]}
              stroke={active ? hot : "rgba(245,247,250,0.32)"}
              strokeWidth={active ? 2 : 1.2}
            />
            <circle cx={m.to[0]} cy={m.to[1]} r={3.5} fill={active ? hot : "rgba(245,247,250,0.6)"} />
          </g>
        );
      })}

      {/* Registration marks */}
      <g stroke="rgba(245,247,250,0.25)" strokeWidth={1.5} fill="none">
        <path d="M 12 32 L 12 12 L 32 12 M 488 12 L 508 12 L 508 32 M 12 868 L 12 888 L 32 888 M 488 888 L 508 888 L 508 868" />
      </g>
    </svg>
  );
}

/**
 * The map with its markers. `counts` is the number of settings in each zone
 * (shown on the marker). Arrow keys move between markers.
 */
export function SledDiagram({
  selected,
  onSelect,
  counts,
}: {
  selected: SuspensionZone | null;
  onSelect: (zone: SuspensionZone) => void;
  counts: Record<SuspensionZone, number>;
}) {
  const refs = useRef<Partial<Record<SuspensionZone, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, zone: SuspensionZone) => {
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = SUSPENSION_ZONES.indexOf(zone);
    const next =
      event.key === "Home"
        ? SUSPENSION_ZONES[0]
        : event.key === "End"
          ? SUSPENSION_ZONES[SUSPENSION_ZONES.length - 1]
          : SUSPENSION_ZONES[(index + step + SUSPENSION_ZONES.length) % SUSPENSION_ZONES.length];
    refs.current[next]?.focus();
    onSelect(next);
  };

  return (
    <div className="relative mx-auto w-full max-w-[400px]" data-testid="sled-diagram">
      <Artwork selected={selected} />
      <div role="group" aria-label="Suspension map" className="absolute inset-0">
        {SUSPENSION_ZONES.map((zone) => {
          const m = MARKERS[zone];
          const active = selected === zone;
          const count = counts[zone];
          return (
            <button
              key={zone}
              ref={(el) => {
                refs.current[zone] = el;
              }}
              type="button"
              aria-pressed={active}
              aria-label={`${ZONE_NUMBER[zone]}. ${ZONE_LABEL[zone]}, ${count} setting${count === 1 ? "" : "s"}`}
              title={ZONE_LABEL[zone]}
              onClick={() => onSelect(zone)}
              onKeyDown={(event) => onKeyDown(event, zone)}
              data-testid="diagram-zone"
              data-zone={zone}
              style={{ left: `${(m.x / W) * 100}%`, top: `${(m.y / H) * 100}%` }}
              className={cn(
                "absolute grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 font-display text-lg font-bold transition",
                "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent-hot",
                active
                  ? "scale-110 border-accent-hot bg-accent text-white shadow-[0_0_0_6px_rgba(255,59,31,0.25),0_0_24px_rgba(255,122,26,0.55)]"
                  : count
                    ? "border-white/70 bg-background/90 text-foreground hover:border-accent-hot hover:text-accent-hot"
                    : "border-dashed border-white/35 bg-background/80 text-muted hover:border-accent-hot hover:text-accent-hot",
              )}
            >
              {ZONE_NUMBER[zone]}
              {count ? (
                <span
                  aria-hidden
                  className={cn(
                    "absolute -right-1 -top-1 grid min-w-5 place-items-center rounded-full px-1 font-sans text-[0.65rem] font-bold leading-5",
                    active ? "bg-white text-primary" : "bg-white/85 text-background",
                  )}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
