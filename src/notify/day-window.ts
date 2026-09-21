/** The time zone of the owner: a "day" for the personal alert limit is a calendar day here. */
export const OWNER_TIME_ZONE = 'America/Sao_Paulo';

export interface DayWindow {
  /** Calendar day in the owner's time zone, YYYY-MM-DD. */
  day: string;
  /** First instant of the day (ISO, UTC), inclusive. */
  start: string;
  /** First instant of the next day (ISO, UTC), exclusive. */
  end: string;
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: OWNER_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const offsetFormat = new Intl.DateTimeFormat('en-US', { timeZone: OWNER_TIME_ZONE, timeZoneName: 'longOffset', hour: '2-digit' });

/** The UTC offset of the owner's zone at an instant, in minutes (Brasília is UTC-3, with no daylight saving today). */
function offsetMinutes(at: Date): number {
  const label = offsetFormat.formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(label);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/** The instant a calendar day (in the owner's zone) starts. Evaluated at noon of that day, away from any clock change. */
function startOfDay(year: number, month: number, day: number): Date {
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  return new Date(Date.UTC(year, month - 1, day) - offsetMinutes(noonUtc) * 60_000);
}

/** The calendar day of `now` in America/Sao_Paulo, as the UTC instants that bound it. */
export function ownerDayWindow(now: Date): DayWindow {
  const day = dayFormat.format(now);
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  return {
    day,
    start: startOfDay(year, month, date).toISOString(),
    end: startOfDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()).toISOString(),
  };
}
