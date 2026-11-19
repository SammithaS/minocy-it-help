import { org } from "../org-config";

/** India has no DST, so IST is a fixed UTC+05:30 offset. */
const IST_OFFSET_MS = 330 * 60_000;
const MIN = 60_000;

/** Shifts a UTC instant into a Date whose UTC fields read as IST wall-clock time. */
const toIst = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS);
const fromIst = (d: Date) => new Date(d.getTime() - IST_OFFSET_MS);

/**
 * SLA due date. Calendar minutes for CRITICAL/HIGH/MEDIUM; for `workingHoursOnly` policies the
 * clock only runs inside working hours (09:00–18:00 IST, Mon–Fri by default).
 */
export function computeSlaDue(
  created: Date,
  minutes: number,
  workingHoursOnly: boolean,
  hours: { start: number; end: number; days: readonly number[] } = org.workingHours,
): Date {
  if (!workingHoursOnly) return new Date(created.getTime() + minutes * MIN);

  let t = toIst(created);
  let remaining = minutes;
  // Walk forward one working window at a time (bounded: 60 days is far beyond any SLA).
  for (let guard = 0; guard < 60 && remaining > 0; guard++) {
    const dayStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), hours.start));
    const dayEnd = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), hours.end));
    const working = hours.days.includes(t.getUTCDay());
    if (!working || t >= dayEnd) {
      // Jump to the start of the next day.
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, hours.start));
      continue;
    }
    if (t < dayStart) t = dayStart;
    const available = (dayEnd.getTime() - t.getTime()) / MIN;
    if (remaining <= available) {
      t = new Date(t.getTime() + remaining * MIN);
      remaining = 0;
    } else {
      remaining -= available;
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, hours.start));
    }
  }
  return fromIst(t);
}
