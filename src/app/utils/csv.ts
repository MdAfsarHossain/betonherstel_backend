// Small CSV helpers shared by the exports. The file starts with a byte order mark and uses
// semicolons by default, so Excel with Dutch settings opens it directly.

// A cell that starts with = + - @ would be run as a formula by Excel: make it plain text
export const csvCell = (value: any, delimiter: string) => {
  let text = value === null || value === undefined ? "" : String(value);
  // (a plain number such as -200,00 is not a formula: credit notes have negative amounts)
  if (/^[=+\-@\t\r]/.test(text) && !/^-\d+(?:[.,]\d+)?$/.test(text)) text = `'${text}`;
  // Only what would break the row is quoted: a decimal comma in a semicolon file stays as it is
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const csvDelimiter = (value: any) => (String(value ?? "semicolon") === "comma" ? "," : ";");

// 1234.5 -> "1234,50" (semicolon files) or "1234.50"
export const csvAmount = (amount: number, delimiter: string) =>
  amount.toFixed(2).replace(".", delimiter === ";" ? "," : ".");

export const buildCsv = (rows: any[][], delimiter: string) =>
  `﻿${rows.map((row) => row.map((cell) => csvCell(cell, delimiter)).join(delimiter)).join("\r\n")}\r\n`;
