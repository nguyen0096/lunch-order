# Menu parsing

Why there are two ways to turn a caterer's message into a menu, and what keeps
the AI one from being a liability.

Both land in the same editable table, and nothing is written until the admin
presses Publish.

## Read with AI

Posts the message to the `parse-assist` Edge Function, which calls DeepSeek's
Anthropic-compatible endpoint. It needs `DEEPSEEK_API_KEY` (see
[Secrets](../reference/secrets.md)); without it the function returns 501 and the
button reports that plainly.

Three things keep it from being a liability:

- **Admin-only.** The caller's JWT is verified and their `admin`/`owner` role
  checked against the org before any request leaves. An unauthenticated LLM
  proxy is someone else's token bill.
- **The shape is forced, then distrusted.** A tool schema with
  `additionalProperties: false` and `price` typed `integer` constrains the
  output; `validateAssist` in `src/shared/menuSchema.ts` re-checks it anyway and
  fails loudly on a float price, a blank name, or 60+ items. A schema is a
  strong constraint, not a guarantee.
- **It cannot reach a bill unseen.** The result populates a preview, then an
  editable table. A human sets every price that ends up in `menu_items`.

The caterer's message is untrusted input: it goes in a delimited user turn, the
system prompt states its contents are data, and the tool schema means the only
route back is a list of dishes and prices.

## Quick parse

The offline regex parser in `src/shared/menuParser.ts`. It is free, instant, and
handles the notations seen so far (`45k`, `40.000đ`, numbered and bulleted
lists, `nghìn`). Kept because most days it is right and costs nothing, and
because it still works when DeepSeek is down or unfunded.

## Related

- [Deploy the Edge Functions](../how-to/deploy-edge-functions.md). CI deploys
  `parse-assist` on every push to `main`; never deploy it by pasting file
  contents into an API call, because the running function then drifts from the
  repo silently.
