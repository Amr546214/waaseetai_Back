/** RFC 4180 CSV with a UTF-8 BOM (Excel opens Arabic text correctly). A cell that starts with = + - @ is prefixed with ' so a spreadsheet never runs it as a formula. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
	const cell = (value: string | number | null | undefined) => {
		let text = value === null || value === undefined ? '' : String(value);
		if (/^[=+\-@]/.test(text) && typeof value === 'string') text = `'${text}`;
		return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	};
	return `﻿${[headers, ...rows].map(r => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
