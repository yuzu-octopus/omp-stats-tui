import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@oh-my-pi/pi-tui";
import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { dashboardPanels } from "../src/tui/features/presentation";
import { renderTimeSeries } from "../src/tui/charts/time-series";
import { glyph, SPARK_LEVELS } from "../src/tui/glyphs";
import type { FeatureContext } from "../src/tui/features/types";

ensureThemeSync();
const ctx: FeatureContext = {
 theme, now: () => 0, changed() {}, copy: async () => {}, openTrace() {}, openScreen() {},
 reader: { fetch: async () => { throw new Error("Rendering must not read data"); }, api: async () => { throw new Error("Rendering must not read data"); } },
};
const axis = [Date.UTC(2026, 6, 14), Date.UTC(2026, 6, 15)];

test("two native buckets retain bounded marks instead of filling their wide slots", () => {
 const marks = new Set(Array.from({length:SPARK_LEVELS}, (_,i) => glyph(ctx.theme.getSymbolPreset(), "sparkRamp", i)));
 for (const width of [40, 100, 160]) {
  const lines = renderTimeSeries(ctx, axis, [{key:"cost",label:"Cost",values:[10,5]}], width, 1, {stacked:true,height:6,legend:false});
  const counts = lines.map(line => [...stripTerminalSequences(line)].filter(char => marks.has(char)).length);
  expect(Math.max(...counts)).toBeLessThanOrEqual(6);
  expect(counts.reduce((sum,count) => sum+count,0)).toBeGreaterThan(0);
  expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
 }
});

test("hidden series omit measured readouts while null and measured zero remain distinct", () => {
 const rows = [{key:"private",label:"Private series",values:[12345,12345]}, {key:"other",label:"Other",values:[null,0]}];
 const text = renderTimeSeries(ctx, axis, rows, 120, 1, {hidden:new Set(["private"]),format:value => String(value)}).map(stripTerminalSequences).join("\n");
 expect(text).not.toContain("12345");
 expect(text).toMatch(/Other\s+0/);
 const missing = renderTimeSeries(ctx, axis, [{key:"gap",label:"Missing",values:[null,null]}],120,1).map(stripTerminalSequences).join("\n");
 expect(missing).not.toMatch(/Missing\s+0(?:\s|$)/);
});

test("paired and stacked panels preserve wrapped terminal content and closing boundaries", () => {
 for (const width of [20,40,100,160]) {
  const body = "Recorded source path: " + "long-directory/".repeat(12) + "END";
  const lines = dashboardPanels(ctx,width,[{title:"Source",render:() => [body]},{title:"Context",render:() => ["Measured context"]}]);
  expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
  expect(lines.map(stripTerminalSequences).join("\n")).toContain("END");
  expect(stripTerminalSequences(lines.at(-1)!)).toContain(ctx.theme.symbol("boxRound.bottomRight"));
 }
});
