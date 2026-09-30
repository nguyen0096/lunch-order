/**
 * The order an admin sends the caterer, as text they can paste into a chat.
 *
 * Written in Vietnamese, unlike every other string in this app. This is the
 * one message whose reader is not a user of the software: it goes to whoever
 * is cooking, in the language they send their menu in. Everything else stays
 * English until the localisation work lands.
 *
 * Each office words it through a template. The app fills in the placeholders
 * with data and nothing else: no placeholder carries wording, so every word
 * the caterer reads is one the office wrote.
 *
 * Pure, and separate from the screen, for the same reason `menuParser` is: the
 * hard part is the wording and the arithmetic, and neither needs a browser to
 * be checked.
 */

export type CatererLine = {
  itemId: number;
  name: string;
  /** Portions of this dish. */
  count: number;
  /** What people asked for on top, with whose it is. */
  notes: Array<{ text: string; who: string }>;
};

export type CatererOrder = {
  serviceDate: string;
  lines: CatererLine[];
  /**
   * Placed orders with no dish chosen. They are a real headcount and no
   * caterer can cook them, so the screen says the number out loud even when
   * the template leaves it out.
   */
  unchosen: number;
};

export const CATERER_PLACEHOLDERS = [
  { key: "companyName", means: "the office's name" },
  { key: "servingDate", means: "the day, as 24/09" },
  { key: "dishes", means: "one line per dish ordered, with its portions" },
  { key: "total", means: "portions in all" },
  { key: "unchosen", means: "people eating with no dish chosen, as a number" },
] as const;

/** Mirrors `organizations_caterer_message_template_ck`. */
export const CATERER_TEMPLATE_MAX = 2000;

/** What an office that never edited its template sends. */
export const DEFAULT_CATERER_TEMPLATE = "Đặt cơm {servingDate}\n{dishes}\nTổng: {total} phần";

const KNOWN_PATTERN = new RegExp(
  `\\{(${CATERER_PLACEHOLDERS.map((p) => p.key).join("|")})\\}`,
  "g",
);

/**
 * `null` when the template can be saved, otherwise the sentence saying what to
 * fix. The database check refuses the same templates without saying which rule
 * was broken.
 */
export function catererTemplateProblem(template: string): string | null {
  if (template.length > CATERER_TEMPLATE_MAX) {
    return `A template is ${CATERER_TEMPLATE_MAX} characters at most`;
  }
  if (!template.includes("{dishes}")) {
    return "The template needs {dishes}, or the caterer is not told what to cook";
  }
  // Known placeholders are removed first, as the database check does, so
  // `{a{total}b}` is refused here too rather than only by the database.
  const rest = template.replace(KNOWN_PATTERN, "");
  const unknown = /\{[A-Za-z_]+\}/.exec(rest);
  if (unknown !== null) return `${unknown[0]} is not a placeholder. Check the spelling`;
  return null;
}

/** DD/MM, which is how a date is written in a Vietnamese chat. */
function dayAndMonth(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${d}/${m}`;
}

export function catererTotal(order: CatererOrder): number {
  return order.lines.reduce((n, l) => n + l.count, 0);
}

/** True when there is nobody to cook for, so there is no message to send. */
export function nobodyOrdered(order: CatererOrder): boolean {
  return catererTotal(order) === 0 && order.unchosen === 0;
}

/**
 * The template with its placeholders filled in. A dish nobody ordered is left
 * out of `{dishes}` rather than sent as a zero.
 */
export function catererMessage(
  order: CatererOrder,
  opts: { companyName: string; template?: string | null },
): string {
  const values: Record<string, string> = {
    companyName: opts.companyName,
    servingDate: dayAndMonth(order.serviceDate),
    dishes: order.lines
      .filter((l) => l.count > 0)
      .map((l) => `- ${l.name}: ${l.count}`)
      .join("\n"),
    total: String(catererTotal(order)),
    unchosen: String(order.unchosen),
  };
  return (opts.template ?? DEFAULT_CATERER_TEMPLATE).replace(
    /\{([A-Za-z_]+)\}/g,
    (whole, key: string) => values[key] ?? whole,
  );
}
