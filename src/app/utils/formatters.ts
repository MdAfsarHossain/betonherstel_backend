import { TLanguage } from "./i18n";

// NFR-USE-04: Dutch formats in Dutch (dd-mm-jjjj, EUR 1.234,56), matching English formats in English.
const locales: Record<TLanguage, string> = { NL: "nl-NL", EN: "en-GB" };

export const formatMoney = (amount: number | string, language: TLanguage) => {
  const value = Number(amount);
  const formatted = new Intl.NumberFormat(locales[language], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
  return `EUR ${formatted}`;
};

export const formatDate = (date: Date | string, language: TLanguage) => {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  // Always show the Netherlands calendar day, whatever the server timezone is
  return new Intl.DateTimeFormat(locales[language], {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Amsterdam",
  })
    .format(d)
    .replace(/\//g, language === "NL" ? "-" : "/");
};

// 09:00 (24-hour clock, Netherlands time)
export const formatTime = (date: Date | string, language: TLanguage) => {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locales[language], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Europe/Amsterdam",
  }).format(d);
};

const dayKey = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Amsterdam" }).format(d);

// "20-11-2026, 09:00 - 11:00", "20-11-2026 09:00 - 24-11-2026 17:00" or, for an
// all-day appointment, "20-11-2026" / "20-11-2026 - 24-11-2026"
export const formatWhen = (start: Date | string, end: Date | string, allDay: boolean, language: TLanguage) => {
  const s = typeof start === "string" ? new Date(start) : start;
  const e = typeof end === "string" ? new Date(end) : end;

  if (allDay) {
    // an all-day appointment ends at the midnight after its last day
    const lastDay = new Date(e.getTime() - 1);
    return dayKey(s) === dayKey(lastDay)
      ? formatDate(s, language)
      : `${formatDate(s, language)} - ${formatDate(lastDay, language)}`;
  }
  if (dayKey(s) === dayKey(e)) {
    return `${formatDate(s, language)}, ${formatTime(s, language)} - ${formatTime(e, language)}`;
  }
  return `${formatDate(s, language)} ${formatTime(s, language)} - ${formatDate(e, language)} ${formatTime(e, language)}`;
};
