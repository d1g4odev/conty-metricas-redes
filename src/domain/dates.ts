const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DateWindow {
  from: string;
  to: string;
}

export const toIsoDay = (date: Date): string => date.toISOString().slice(0, 10);

export function isIsoDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(time) && toIsoDay(new Date(time)) === value;
}

export function daysInWindow(window: DateWindow): number {
  const from = Date.parse(`${window.from}T00:00:00.000Z`);
  const to = Date.parse(`${window.to}T00:00:00.000Z`);
  return Math.floor((to - from) / DAY_MS) + 1;
}

export function eachDay(window: DateWindow): string[] {
  const start = Date.parse(`${window.from}T00:00:00.000Z`);
  return Array.from({ length: Math.max(daysInWindow(window), 0) }, (_, index) =>
    toIsoDay(new Date(start + index * DAY_MS)),
  );
}

export const isWithin = (day: string, window: DateWindow): boolean =>
  day >= window.from && day <= window.to;
