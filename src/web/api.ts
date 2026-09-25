/**
 * Every query the browser makes, grouped by the screen that asks it.
 *
 * A barrel rather than a move: screens import `./api.js` and do not care which
 * module a function lives in, and one file per domain means two people editing
 * two screens do not edit the same file.
 */

export * from "./api/core.js";
export * from "./api/board.js";
export * from "./api/billing.js";
export * from "./api/corrections.js";
export * from "./api/menu.js";
export * from "./api/messages.js";
export * from "./api/people.js";
export * from "./api/settings.js";
