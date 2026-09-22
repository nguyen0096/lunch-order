import { useCallback, useEffect, useState } from "react";
import {
  createTelegramLink, fetchStandingOrders, fetchTelegramLink, humanError, setDisplayName,
  setStandingOrder, unlinkTelegram, type TelegramLink,
} from "../api.js";
import { botDeepLink } from "../../shared/telegram.js";
import type { Me, Org, Role } from "../../shared/types.js";

const DAYS: Array<[number, string]> = [
  [1, "Monday"], [2, "Tuesday"], [3, "Wednesday"],
  [4, "Thursday"], [5, "Friday"], [6, "Saturday"],
];

// Optional, so it is read off the env bag rather than through ImportMetaEnv,
// which declares only the two variables the app cannot start without. An
// absent value is a deployment without a bot, not a broken one.
const BOT_USERNAME =
  (import.meta.env as unknown as Record<string, string | undefined>)["VITE_TELEGRAM_BOT"] ?? "";

export function PrefsScreen(
  { me, org, role, displayName, onRenamed }:
  { me: Me; org: Org; role: Role; displayName: string; onRenamed: () => void },
) {
  const [name, setName] = useState(displayName);
  const [nameSaving, setNameSaving] = useState(false);
  const [days, setDays] = useState<Set<number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    fetchStandingOrders(org.id, me.profileId)
      .then(setDays)
      .catch((e) => { setError(humanError(e)); setDays(new Set()); });
  }, [org.id, me.profileId]);
  useEffect(load, [load]);

  async function toggle(weekday: number) {
    if (!days) return;
    const next = new Set(days);
    const enabled = !next.has(weekday);
    if (enabled) next.add(weekday); else next.delete(weekday);
    setDays(next);
    try {
      await setStandingOrder({ orgId: org.id, profileId: me.profileId, weekday, enabled });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      setError(null);
    } catch (e) {
      load();
      setError(humanError(e));
    }
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setNameSaving(true);
    try {
      await setDisplayName({ orgId: org.id, profileId: me.profileId, displayName: name });
      onRenamed();
      setError(null);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setNameSaving(false);
    }
  }

  return (
    <section>
      <h1>Preferences</h1>
      {error && <p className="notice error" role="alert">{error}</p>}

      <h2>Your name</h2>
      {/* Per-org, not per-account: this is the name colleagues see on the
          board, and the same person may go by different names elsewhere. */}
      <p className="muted">
        How you appear on the board in {org.name}. Signed in as {me.email}
        {role === "owner" || role === "admin" ? " (admin)" : ""}.
      </p>
      <form className="name-form" onSubmit={(e) => void saveName(e)}>
        <input aria-label="Display name" value={name}
               onChange={(e) => setName(e.target.value)} maxLength={80} />
        <button className="btn" type="submit"
                disabled={nameSaving || name.trim() === "" || name === displayName}>
          {nameSaving ? "Saving…" : "Save"}
        </button>
      </form>

      <h2>Standing order</h2>
      {/* Say what this actually does. "Auto-order" is ambiguous about whether
          a dish gets picked for you, and it does not. */}
      <p className="muted">
        On these days you'll be marked as eating as soon as the menu is published,
        and they show on the board as a dashed tick before that happens. You still
        pick your dish, and you can change or cancel until the cutoff.
      </p>
      <p className="muted">
        Turning a day off stops future orders. An order already created stays —
        untick that day on the board to cancel it.
      </p>

      {days === null ? (
        // Skeleton rows rather than an empty checklist: showing unchecked
        // boxes and then ticking them looks like the app editing your
        // settings behind your back.
        <ul className="days" aria-busy="true">
          {DAYS.map(([n]) => (
            <li key={n}><span className="row skeleton" /></li>
          ))}
        </ul>
      ) : (
        <ul className="days">
          {DAYS.map(([n, label]) => (
            <li key={n}>
              <label className="row">
                <input type="checkbox" checked={days.has(n)}
                       onChange={() => void toggle(n)} />
                <span>{label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {saved && <p className="muted">Saved</p>}

      <TelegramSection me={me} org={org} />
    </section>
  );
}

/**
 * The bot link, which is a credential: telegram_links is a separate table
 * precisely so a token is readable by its owner and nobody else. The row is
 * created on the first tap, not on load, so a member who never wants the bot
 * never has a token that could be used to bind a chat to their membership.
 */
function TelegramSection({ me, org }: { me: Me; org: Org }) {
  const [link, setLink] = useState<TelegramLink | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchTelegramLink(org.id, me.profileId)
      .then(setLink)
      .catch((e) => { setError(humanError(e)); setLink(null); });
  }, [org.id, me.profileId]);
  useEffect(load, [load]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  const deepLink = link ? botDeepLink(BOT_USERNAME, link.linkToken) : null;

  return (
    <>
      <h2>Telegram</h2>
      <p className="muted">
        Order, cancel and check what you owe from a chat, and get a nudge before
        the cutoff.
      </p>
      {error && <p className="notice error" role="alert">{error}</p>}

      {link === undefined ? (
        <p className="muted" aria-busy="true">Checking…</p>
      ) : link === null ? (
        <button className="btn" type="button" disabled={busy}
                onClick={() => void run(async () => {
                  setLink(await createTelegramLink(org.id, me.profileId));
                })}>
          {busy ? "Working…" : "Connect Telegram"}
        </button>
      ) : link.linked ? (
        <>
          <p>Connected. Send <code>/today</code> to the bot to order.</p>
          <button className="btn" type="button" disabled={busy}
                  onClick={() => void run(async () => {
                    await unlinkTelegram(link.membershipId);
                    setLink({ ...link, linked: false });
                  })}>
            {busy ? "Working…" : "Disconnect"}
          </button>
        </>
      ) : deepLink !== null ? (
        <>
          <p>
            <a className="btn" href={deepLink} target="_blank" rel="noreferrer">
              Open the bot
            </a>
          </p>
          <p className="muted">
            It opens a chat with your connect code already filled in. Come back
            and reload once you've sent it.
          </p>
          <button className="btn" type="button" disabled={busy}
                  onClick={() => void run(async () => { load(); })}>
            I've connected
          </button>
        </>
      ) : (
        // No VITE_TELEGRAM_BOT: the code still works, so show it rather than a
        // link to nowhere. Whoever runs this deployment knows their bot's name.
        <>
          <p className="muted">
            Send this to the lunch bot on Telegram:
          </p>
          <p><code>/start {link.linkToken}</code></p>
        </>
      )}
    </>
  );
}
