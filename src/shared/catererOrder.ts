/**
 * The order an admin sends the caterer, as text they can paste into a chat.
 *
 * Written in Vietnamese, unlike every other string in this app. This is the
 * one message whose reader is not a user of the software: it goes to whoever
 * is cooking, in the language they send their menu in. Everything else stays
 * English until the localisation work lands.
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
   * caterer can cook them, so the message has to say the number out loud
   * rather than quietly leaving it out of the total.
   */
  unchosen: number;
};

/** DD/MM, which is how a date is written in a Vietnamese chat. */
function dayAndMonth(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${d}/${m}`;
}

/**
 * One dish per line, portions after it, notes indented underneath.
 *
 * The name is carried on a note line because the caterer hands the boxes to a
 * person: "ít cơm" against nobody is an instruction they cannot deliver.
 */
export function catererMessage(order: CatererOrder): string {
  const lines: string[] = [`Đặt cơm ${dayAndMonth(order.serviceDate)}`];

  for (const line of order.lines) {
    if (line.count === 0) continue;
    lines.push(`- ${line.name}: ${line.count} phần`);
    for (const note of line.notes) {
      lines.push(`  + ${note.who}: ${note.text}`);
    }
  }

  const total = order.lines.reduce((n, l) => n + l.count, 0);
  if (total === 0 && order.unchosen === 0) return `${lines[0]}\nChưa có ai đặt.`;

  lines.push(`Tổng: ${total} phần`);

  if (order.unchosen > 0) {
    // Said last and said plainly. It is the one number in the message that
    // needs a human to resolve before the food is made.
    lines.push(
      `(Còn ${order.unchosen} người đã đăng ký nhưng chưa chọn món, em sẽ báo lại sau)`,
    );
  }

  return lines.join("\n");
}
