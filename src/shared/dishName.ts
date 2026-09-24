/**
 * How a dish name is written, wherever one comes from.
 *
 * Caterers write in chat, and chat is lower case: `cơm gà 45k`. Admins were
 * fixing the capital by hand on every row of every menu, which is a correction
 * the app can make once and let them override.
 *
 * Sentence case, not title case. `Cơm gà`, never `Cơm Gà`: Vietnamese does not
 * capitalise each word, and a rule that did would also break `Mì Quảng`, where
 * the capital belongs to the province rather than to the position.
 *
 * NFC as well, for a reason that has nothing to do with looks. `menu_items`
 * carries `unique (menu_id, lower(btrim(name)))`, and iOS keyboards emit
 * decomposed Vietnamese, so `Cơm` typed on a phone and `Cơm` pasted from the
 * caterer are different strings to that index and both would be accepted onto
 * one menu. The parsers already normalise; this covers what people type.
 */
export function dishName(raw: string): string {
  const text = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (text === "") return text;
  const first = text.slice(0, 1);
  const upper = first.toUpperCase();
  // Only when it changes something: a name that already starts with a capital,
  // a digit or a bullet is left exactly as the person wrote it.
  return upper === first ? text : upper + text.slice(1);
}
