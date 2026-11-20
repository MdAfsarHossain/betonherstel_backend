// Minimal iCalendar (RFC 5545) writer for calendar subscriptions (FR-PLAN-08) and
// the appointment confirmation attachment (FR-PLAN-07). Opens in Google Calendar,
// Apple Calendar and Outlook.

export interface IIcsEvent {
  uid: string;
  start: Date;
  end: Date;
  // All-day events use dates, not times; `end` is exclusive (the day after the last day)
  allDay: boolean;
  summary: string;
  location?: string | null;
  description?: string | null;
  status: "CONFIRMED" | "CANCELLED";
  updated: Date;
}

const pad = (n: number) => String(n).padStart(2, "0");

// 20261120T080000Z
const utc = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

// 20261120: the calendar day in the Netherlands
const amsterdamDay = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Europe/Amsterdam",
  })
    .format(d)
    .replace(/-/g, "");

// Backslash, semicolon, comma and line breaks must be escaped in text values
export const escapeIcsText = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

// Lines are at most 75 octets; longer ones continue on the next line after a space.
// Never splits a multi-byte character.
export const foldIcsLine = (line: string) => {
  if (Buffer.byteLength(line) <= 75) return line;

  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch);
    if (currentBytes + bytes > limit) {
      parts.push(current);
      current = "";
      currentBytes = 0;
      limit = 74; // a continuation line starts with one space
    }
    current += ch;
    currentBytes += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
};

const eventLines = (e: IIcsEvent, now: Date) => {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${utc(now)}`,
    `LAST-MODIFIED:${utc(e.updated)}`,
    // Calendars refresh an event when its sequence goes up
    `SEQUENCE:${Math.floor(e.updated.getTime() / 1000)}`,
    e.allDay ? `DTSTART;VALUE=DATE:${amsterdamDay(e.start)}` : `DTSTART:${utc(e.start)}`,
    e.allDay ? `DTEND;VALUE=DATE:${amsterdamDay(e.end)}` : `DTEND:${utc(e.end)}`,
    `SUMMARY:${escapeIcsText(e.summary)}`,
  ];
  if (e.location) lines.push(`LOCATION:${escapeIcsText(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
  lines.push(`STATUS:${e.status}`, "TRANSP:OPAQUE", "END:VEVENT");
  return lines;
};

export const buildIcs = (events: IIcsEvent[], calendarName: string, now = new Date()) => {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Betonherstel.nl//CRM Planning//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    "X-WR-TIMEZONE:Europe/Amsterdam",
    ...events.flatMap((e) => eventLines(e, now)),
    "END:VCALENDAR",
  ];
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
};
