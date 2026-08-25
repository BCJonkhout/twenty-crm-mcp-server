// Wall-clock time in the team's zone ↔ the UTC instants Twenty stores.
//
// This lives on its own because BOTH sides of a due date need it and they sit
// on opposite sides of an import: `commands/tasks.ts` writes and renders due
// dates, `filters.ts` builds the windows that search for them. When only the
// write side knew about Europe/Amsterdam, `--due 2026-09-04` stored
// 2026-09-03T22:00Z while `--due-after 2026-09-04` asked for >= 2026-09-04T00:00Z,
// so a list silently skipped the very cards it had just written.

/** Due dates are entered and shown in the team's zone, not the host's. */
export const DUE_TIME_ZONE = "Europe/Amsterdam";

export interface WallClock {
  y: number;
  m: number;
  d: number;
  hh?: number;
  mm?: number;
  ss?: number;
}

/** How far `timeZone` runs ahead of UTC at the given instant, in ms. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return wall - utcMs;
}

/**
 * Wall-clock time in `timeZone` → the UTC instant. Two passes, because the
 * offset that applies depends on the instant we are still computing: the first
 * guess uses the offset at the naive timestamp, the second re-reads it at the
 * corrected instant. That is what makes the DST changeover days come out right.
 */
export function zonedToUtc(wall: WallClock, timeZone: string = DUE_TIME_ZONE): Date {
  const guess = Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh ?? 0, wall.mm ?? 0, wall.ss ?? 0);
  let utc = guess - zoneOffsetMs(guess, timeZone);
  const second = zoneOffsetMs(utc, timeZone);
  if (guess - second !== utc) utc = guess - second;
  return new Date(utc);
}

/** `2026-09-04` → true only if that day exists (rejects 2026-02-30). */
export function isRealDay(y: number, m: number, d: number): boolean {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Midnight of `day` in `timeZone`, as an ISO instant, optionally shifted by a
 * whole number of days. `zonedDayStartIso("2026-09-04")` is the moment the 4th
 * begins here; `+1` is the moment it ends, which is the exclusive upper bound
 * for "due on or before the 4th".
 *
 * Returns null when `day` is not a real YYYY-MM-DD — the caller words the error.
 */
export function zonedDayStartIso(
  day: string, plusDays = 0, timeZone: string = DUE_TIME_ZONE,
): string | null {
  const m = DAY_RE.exec(day.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isRealDay(y, mo, d)) return null;
  // Shifting the calendar day (not the instant) keeps this correct across a DST
  // boundary, where "+24 hours" is 23 or 25 hours of wall-clock time.
  const shifted = new Date(Date.UTC(y, mo - 1, d + plusDays));
  return zonedToUtc({
    y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(),
  }, timeZone).toISOString();
}
