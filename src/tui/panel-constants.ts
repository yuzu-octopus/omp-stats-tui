/**
 * The numbers the panel's chrome is measured against, in one place.
 *
 * WHY A SEPARATE FILE. `frame.ts` needs to know how many rows `OverlayPanel`
 * draws around the body, and `panel.ts` needs to know the same thing. Putting the
 * constant in either one makes the other import it from the module it is
 * describing — a cycle, or a lie about which side owns the claim. The value is a
 * MEASUREMENT of `OverlayPanel.render` (top border, tab row, divider, footer,
 * bottom border) and both sides must read the same measurement, so neither owns
 * it.
 *
 * Kept to one number on purpose. Anything else that would live here is chrome
 * the panel draws, and chrome the panel draws belongs to the panel.
 */

/**
 * Rows `OverlayPanel` draws AROUND the body: top border, the tab/header row,
 * `PanelDivider`, footer, bottom border.
 *
 * The single chrome-row measurement. `frame.ts` and `layout.ts` import it, so
 * the claim about the frame and the frame itself cannot drift apart.
 */
export const PANEL_CHROME_ROWS = 5;