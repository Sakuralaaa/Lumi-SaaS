/** Start of the current day in Asia/Shanghai (UTC+8, no DST), as a Date. */
export function shanghaiDayStart(now = new Date()): Date {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 8 * 3600_000);
}
