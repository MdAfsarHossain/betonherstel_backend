// Calendar days in the Netherlands, as "YYYY-MM-DD" strings. Dates such as a
// quotation's validity are plain calendar days: they must not shift with the
// server's timezone, so they are never turned into JavaScript Date objects.

export const isValidDay = (day: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
};

// Today in Amsterdam
export const amsterdamToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Europe/Amsterdam",
  }).format(now);

export const addDays = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
