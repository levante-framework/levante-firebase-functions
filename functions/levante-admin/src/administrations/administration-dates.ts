import { format } from "date-fns";
import { TZDate, tz } from "@date-fns/tz";

/** Calendar day (YYYY-MM-DD) for `date` in `timeZone`. */
export function dayInTz(date: Date, timeZone: string): string {
  return format(date, "yyyy-MM-dd", { in: tz(timeZone) });
}

/** Wall-clock instant for `day` (YYYY-MM-DD) at h:m:s.ms in `timeZone`. */
export function atTimeInTz(
  day: string,
  timeZone: string,
  hour: number,
  minute: number,
  second: number,
  ms: number
): Date {
  const [year, month, dayNum] = day.split("-").map(Number);
  return new Date(
    new TZDate(
      year,
      month - 1,
      dayNum,
      hour,
      minute,
      second,
      ms,
      timeZone
    ).getTime()
  );
}
