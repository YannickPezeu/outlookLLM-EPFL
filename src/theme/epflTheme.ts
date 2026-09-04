import { createLightTheme, type BrandVariants, type Theme } from "@fluentui/react-components";

/**
 * EPFL visual identity for Fluent UI v9.
 *
 * The add-in styles itself entirely through Fluent tokens — there is not a
 * single literal colour in the UI — so the identity is applied where Fluent
 * expects it: a brand ramp handed to `createLightTheme`, which regenerates
 * every `colorBrand*` token from it. Nothing else in the components changes.
 *
 * The ramp is hue 0 throughout, because the three official EPFL reds all are,
 * and it is anchored so that it passes through them exactly:
 *
 *   brand[60]  = #891818   Elements' :active red
 *   brand[80]  = #b51f1f   Elements' dark red
 *   brand[110] = #ff0000   the EPFL brand red
 *
 * Slot 80 is the load-bearing one: Fluent maps it to both `colorBrandBackground`
 * (the primary button fill, white text on it) and `colorBrandForeground1` (brand
 * text on white). That is why #b51f1f sits there and #ff0000 does not — white on
 * #ff0000 is 4.0:1, below the 4.5:1 AA floor, whereas #b51f1f gives 6.6:1 both
 * ways. The brand red keeps slot 110, where Fluent only ever uses it as an
 * inverted foreground on dark ground.
 *
 * Every brand pair Fluent derives from this ramp was checked: the weakest is
 * brand[80] on brand[160] at 5.5:1, the rest are 6.6:1 or better.
 */
export const epflBrand: BrandVariants = {
  10: "#230606",
  20: "#350909",
  30: "#460b0b",
  40: "#5c1010",
  50: "#711313",
  60: "#891818",
  70: "#9d1b1b",
  80: "#b51f1f",
  90: "#d51a1a",
  100: "#f00a0a",
  110: "#ff0000",
  120: "#ff3333",
  130: "#ff6666",
  140: "#ff9494",
  150: "#ffc2c2",
  160: "#ffe5e5",
};

/**
 * Suisse Int'l is the EPFL Brand Guidelines typeface; Arial is the fallback
 * they themselves prescribe, and is what will actually render — the add-in runs
 * inside Outlook, where the licensed face is not installed. Segoe UI stays in
 * the stack after it so the panel still sits naturally in the Office chrome.
 */
// Backticks, and double quotes around the family name: it contains an
// apostrophe, so single quotes would close the CSS string on it.
const epflFontFamily = `"Suisse Int'l", Arial, "Segoe UI", system-ui, -apple-system, sans-serif`;

export const epflLightTheme: Theme = {
  ...createLightTheme(epflBrand),
  fontFamilyBase: epflFontFamily,
};
