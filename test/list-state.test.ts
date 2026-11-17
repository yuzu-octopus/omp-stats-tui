import { expect, test } from "bun:test";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { glyph } from "../src/tui/glyphs";
import { stripForTest } from "../src/tui/palette";
import { ListState, type ListColumn } from "../src/tui/features/core/shared";
import type { FeatureContext } from "../src/tui/features/types";

ensureThemeSync();

const ctx = {
	theme,
	now: () => 0,
	changed() {},
	copy: async () => {},
	openTrace() {},
	openScreen() {},
	reader: { fetch: async () => ({}), api: async () => ({}) },
} as unknown as FeatureContext;

test("a vanished selection becomes the painted row and the next arrow moves to the second row", () => {
	const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
	const list = new ListState<(typeof rows)[number]>(row => String(row.id), "id");
	list.selected = "999";
	const columns: ListColumn<(typeof rows)[number]>[] = [
		{ key: "id", header: "Id", align: "left", value: row => `row ${row.id}` },
	];
	const text = stripForTest(list.render(rows, 40, 20, columns, ctx, "Records").join("\n"));
	const cursor = glyph(theme.getSymbolPreset(), "rowCursor");
	expect(text).toContain(`${cursor} row 1`);
	expect(list.selected).toBe("1");
	list.input("j", rows);
	expect(list.selected).toBe("2");
});

test("wrapped search lines shift click hits by the emitted line count", () => {
	const rows = [{ id: "A-ROW" }, { id: "B-ROW" }, { id: "C-ROW" }];
	const list = new ListState<(typeof rows)[number]>(row => row.id, "id");
	list.search = "long search phrase that must wrap ".repeat(3);
	const columns: ListColumn<(typeof rows)[number]>[] = [
		{ key: "id", header: "Id", align: "left", value: row => row.id },
	];
	const lines = stripForTest(list.render(rows, 20, 20, columns, ctx, "Records").join("\n")).split("\n");
	const firstRecordRow = lines.findIndex(line => line.includes("A-ROW"));
	expect(firstRecordRow).toBeGreaterThan(-1);
	expect(list.lastHits[0].rowStart).toBe(firstRecordRow);
});
