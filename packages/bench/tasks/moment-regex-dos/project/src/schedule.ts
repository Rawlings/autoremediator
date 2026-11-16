import moment from "moment";

/** The next Monday-to-Friday date after `iso`, as YYYY-MM-DD (UTC). */
export function nextBusinessDay(iso: string): string {
  const day = moment.utc(iso);
  do {
    day.add(1, "day");
  } while (day.isoWeekday() > 5);
  return day.format("YYYY-MM-DD");
}

export function describeDuration(minutes: number): string {
  return moment.duration(minutes, "minutes").humanize();
}
