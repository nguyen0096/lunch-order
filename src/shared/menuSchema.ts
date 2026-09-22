/**
 * The shape the model is *forced* to return, and the validation that assumes
 * it did not.
 *
 * A tool schema is a strong constraint, not a guarantee: the provider may
 * truncate, a model may emit a string where a number belongs, and a prompt
 * injection inside the caterer's message may try for something stranger. So
 * everything crossing this boundary is re-checked here before it reaches the
 * admin's screen, let alone the database.
 */
export const MENU_TOOL_SCHEMA = {
  type: "object",
  properties: {
    service_date: {
      type: ["string", "null"],
      description:
        "The date the food is for, as YYYY-MM-DD, if the message states or implies one. " +
        "Null if it does not. Never guess.",
    },
    items: {
      type: "array",
      description: "One entry per dish actually offered.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The dish name only, with no price, no list number and no trailing punctuation. " +
              "Preserve Vietnamese diacritics exactly as written.",
          },
          price: {
            type: "integer",
            description:
              "Price in whole Vietnamese dong. '45k' is 45000. '40.000d' is 40000. " +
              "A bare number under 1000 means thousands, so '45' is 45000.",
          },
          note: {
            type: ["string", "null"],
            description: "Anything qualifying this dish, e.g. 'limited', 'spicy'. Null if none.",
          },
        },
        required: ["name", "price"],
        additionalProperties: false,
      },
    },
    notes: {
      type: "array",
      description:
        "Lines that are not dishes: headers, ordering deadlines, phone numbers, greetings.",
      items: { type: "string" },
    },
  },
  required: ["items", "notes"],
  additionalProperties: false,
} as const;

export type AssistItem = { name: string; price: number; note: string | null };
export type AssistResult = {
  serviceDate: string | null;
  items: AssistItem[];
  notes: string[];
};

const MAX_ITEMS = 60;
const MIN_PRICE = 0;
const MAX_PRICE = 100_000_000;

/** Throws with a readable reason rather than passing a bad shape onward. */
export function validateAssist(raw: unknown): AssistResult {
  if (typeof raw !== "object" || raw === null) throw new Error("model returned no object");
  const o = raw as Record<string, unknown>;

  if (!Array.isArray(o["items"])) throw new Error("model returned no items array");
  if (o["items"].length > MAX_ITEMS) throw new Error(`model returned ${o["items"].length} items`);

  const items: AssistItem[] = o["items"].map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`item ${i} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e["name"] === "string" ? e["name"].trim() : "";
    if (name === "") throw new Error(`item ${i} has no name`);
    if (name.length > 200) throw new Error(`item ${i} name is implausibly long`);

    // Accept a numeric string so a model that quotes the number is not a hard
    // failure, but never accept a float: money here is integer dong.
    const rawPrice = e["price"];
    const price =
      typeof rawPrice === "number" ? rawPrice
      : typeof rawPrice === "string" && /^\d+$/.test(rawPrice.trim()) ? Number(rawPrice.trim())
      : Number.NaN;
    if (!Number.isInteger(price) || price < MIN_PRICE || price > MAX_PRICE) {
      throw new Error(`item ${i} ("${name}") has an unusable price`);
    }
    return { name, price, note: typeof e["note"] === "string" ? e["note"] : null };
  });

  const sd = o["service_date"];
  const serviceDate =
    typeof sd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sd) && !Number.isNaN(Date.parse(sd))
      ? sd
      : null;

  const notes = Array.isArray(o["notes"])
    ? o["notes"].filter((n): n is string => typeof n === "string").slice(0, 40)
    : [];

  return { serviceDate, items, notes };
}
