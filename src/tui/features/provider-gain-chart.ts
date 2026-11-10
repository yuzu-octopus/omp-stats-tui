import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

/** Keep the selected record visible without borrowing the panel's global scroll. */
export function recordViewport<T>(rows: readonly T[], selected: number, height: number, reveal: number, reserve = 13): { rows: readonly T[]; start: number } {
	const count = Math.max(1, Math.min(reveal, Math.max(3, height - reserve)));
	const start = Math.max(0, Math.min(rows.length - count, selected - Math.floor(count / 2)));
	return { rows: rows.slice(start, start + count), start };
}
export function boundLines(lines: readonly string[], width: number): string[] {
	return lines.map(line => visibleWidth(line) > width ? truncateToWidth(line, Math.max(0, width)) : line);
}
