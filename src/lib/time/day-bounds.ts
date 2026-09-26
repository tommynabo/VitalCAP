export interface DayBounds {
  start: Date;
  end: Date;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsFor(date: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return values as unknown as DateParts;
}

function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  const local = partsFor(candidate, timeZone);
  const desired = Date.UTC(year, month - 1, day);
  const rendered = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return new Date(candidate.getTime() + desired - rendered);
}

export function getDayBounds(timeZone: string, now = new Date()): DayBounds {
  const local = partsFor(now, timeZone);
  const start = zonedMidnight(local.year, local.month, local.day, timeZone);
  const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const end = zonedMidnight(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), timeZone);
  return { start, end };
}
