import { useEffect, useState } from "react";
import { acceptInvitation, humanError } from "../api.js";

/**
 * Landing page for an invitation link. Deliberately not automatic: joining an
 * org is a consequential action, and clicking a link someone pasted in a chat
 * should not silently enrol you.
 */
export function JoinScreen({ token, onJoined }: { token: string; onJoined: () => void }) {
  const [state, setState] = useState<"ready" | "working" | "done">("ready");
  const [org, setOrg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setState("ready"); setError(null); }, [token]);

  async function join() {
    setState("working");
    try {
      const result = await acceptInvitation(token);
      setOrg(result.name);
      setState("done");
      onJoined();
    } catch (e) {
      // The function's messages are written for people -- "This invitation was
      // sent to x. You are signed in as y." -- so show them as they are.
      setError(humanError(e));
      setState("ready");
    }
  }

  if (state === "done") {
    return (
      <main className="center">
        <h1>You're in</h1>
        <p className="muted">Joined {org}.</p>
        <a className="btn primary" href="#/">Go to the board</a>
      </main>
    );
  }

  return (
    <main className="center">
      <h1>Join an office</h1>
      {error && <p className="notice error" role="alert">{error}</p>}
      <p className="muted">
        You've been invited to an office lunch board. Accepting adds you to it and
        lets colleagues see what you order.
      </p>
      <button className="btn primary" disabled={state === "working"}
              onClick={() => void join()}>
        {state === "working" ? "Joining…" : "Accept invitation"}
      </button>
    </main>
  );
}
