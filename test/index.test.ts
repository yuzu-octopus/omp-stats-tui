import { test, expect } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import register from "../src/index";

/**
 * A minimal fake host. It records what the extension registers so the test can
 * assert on the *contract* the entrypoint owes the loader — a command named
 * exactly `stats-tui` — without booting a TUI. Kept here, never in `src/`.
 */
function fakePi() {
	const commands: {
		name: string;
		options: { description?: string; handler?: unknown };
	}[] = [];
	// Cast through `never`: the fake deliberately implements only the slice of
	// ExtensionAPI this entrypoint touches, and widening it as the entrypoint
	// grows is the point of the test rather than a failure.
	const pi = {
		registerCommand(name: string, options: { description?: string; handler?: unknown }) {
			commands.push({ name, options });
		},
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

test("the extension registers exactly one command: /stats-tui", () => {
	// An extension registering a name the host already provides appears in the
	// palette and is never run (ADR 0002), so the list is pinned exactly rather
	// than checked for a superset.
	const { pi, commands } = fakePi();
	register(pi);
	expect(commands.map(c => c.name)).toEqual(["stats-tui"]);
});

test("the command carries a description and a callable handler", () => {
	const { pi, commands } = fakePi();
	register(pi);
	expect(commands).toHaveLength(1);
	for (const command of commands) {
		expect(command.options.description).toBeString();
		expect(typeof command.options.handler).toBe("function");
	}
});
