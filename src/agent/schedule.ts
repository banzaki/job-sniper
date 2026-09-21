import type { HunterConfig } from './hunter-config.js';
import type { HunterState } from './state.js';

/** A scheduled slot runs only if the tick arrives within this many minutes after it; later, it is missed and never run. */
export const SLOT_GRACE_MINUTES = 20;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(ms: number, timeZone: string): LocalParts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(timeZone, formatter);
  }
  const value = (type: string): number => Number(formatter!.formatToParts(new Date(ms)).find((part) => part.type === type)?.value ?? 0);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute') };
}

/** The offset of a zone (local minus UTC, in ms) at an instant, to the minute. */
function offsetMs(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
}

/** The instant at which the wall clock of `timeZone` reads year-month-day hh:mm. */
export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall - offsetMs(wall, timeZone);
  instant = wall - offsetMs(instant, timeZone); // once more, in case the offset differs at the guessed instant (a DST change)
  return instant;
}

const pad = (n: number): string => String(n).padStart(2, '0');
export const slotKey = (year: number, month: number, day: number, time: string): string => `${year}-${pad(month)}-${pad(day)}@${time}`;

interface Slot {
  key: string;
  at: number;
}

/** Every slot of the local days around `now` (yesterday, today, the next two), in time order. */
function slotsAround(now: Date, config: Pick<HunterConfig, 'timezone' | 'scheduleTimes'>): Slot[] {
  const today = localParts(now.getTime(), config.timezone);
  const slots: Slot[] = [];
  for (let offset = -1; offset <= 2; offset += 1) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const [year, month, date] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    for (const time of config.scheduleTimes) {
      const [hour, minute] = time.split(':').map(Number) as [number, number];
      slots.push({ key: slotKey(year, month, date, time), at: zonedInstant(year, month, date, hour, minute, config.timezone) });
    }
  }
  return slots.sort((a, b) => a.at - b.at);
}

/** The next scheduled run strictly after `now`, or null when the schedule is off. Only informative: it never starts anything. */
export function nextRun(now: Date, config: HunterConfig): { key: string; at: string; local: string } | null {
  if (!config.scheduleEnabled) return null;
  const slot = slotsAround(now, config).find((candidate) => candidate.at > now.getTime());
  if (!slot) return null;
  return { key: slot.key, at: new Date(slot.at).toISOString(), local: slot.key.replace('@', ' ') };
}

export type TickDecision =
  | { action: 'run'; slot: string }
  | { action: 'skip'; reason: 'schedule_disabled' | 'no_slot_due' | 'already_started' | 'missed'; slot?: string };

/**
 * What a periodic tick must do. It runs a slot only when the moment is inside [slot, slot + grace] and that slot was never
 * started (the ledger is written BEFORE the run, so a restart or a second tick cannot repeat it). It never runs outside the
 * configured times; a slot the machine was off for is reported as missed and is not made up.
 */
export function decideTick(now: Date, config: HunterConfig, state: HunterState): TickDecision {
  if (!config.scheduleEnabled) return { action: 'skip', reason: 'schedule_disabled' };
  const graceMs = SLOT_GRACE_MINUTES * 60_000;
  const passed = slotsAround(now, config).filter((slot) => slot.at <= now.getTime());
  const latest = passed[passed.length - 1];
  if (!latest) return { action: 'skip', reason: 'no_slot_due' };
  if (state.slots[latest.key]) return { action: 'skip', reason: 'already_started', slot: latest.key };
  if (now.getTime() - latest.at > graceMs) return { action: 'skip', reason: 'missed', slot: latest.key };
  return { action: 'run', slot: latest.key };
}

/** Keeps the ledger short: slots older than 14 days are forgotten. */
export function pruneSlots(slots: HunterState['slots'], now: Date): HunterState['slots'] {
  const limit = now.getTime() - 14 * 86_400_000;
  return Object.fromEntries(Object.entries(slots).filter(([, record]) => Date.parse(record.startedAt) >= limit));
}
