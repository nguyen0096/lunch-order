import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { humanError } from "@/api";

export type ActionResult<R> = { ok: true; data: R } | { ok: false; error: string };

export type UseActionOptions<R> = {
  /**
   * Past tense of the button's own verb: Publish produces "Published". A
   * function when the sentence needs the result, for example a count.
   */
  success?: string | ((data: R) => string);
  /** Runs only after the write succeeded, typically a refetch or a close. */
  onSuccess?: (data: R) => void;
};

export type Action<Args extends unknown[], R> = {
  /** Never rejects. The outcome is in the returned result. */
  run: (...args: Args) => Promise<ActionResult<R>>;
  pending: boolean;
  /** The last failure, for a screen that also wants it inline. */
  error: string | null;
  reset: () => void;
};

/**
 * Every mutation goes through here: pending state, the success toast and the
 * failure toast, once, in one place. A screen that writes its own
 * try/catch/setError is the eighth way to report failure, and the seven
 * before it all disagreed about wording.
 *
 * Failures are reported through `humanError`, so the database's own sentence
 * reaches the person unedited. That matters because the constraints in this
 * schema are written to be read: "Ordering closed at 21:00" is worth more than
 * "Something went wrong".
 */
export function useAction<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  options: UseActionOptions<R> = {},
): Action<Args, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in refs so `run` keeps a stable identity across renders: it is
  // routinely a dependency of an effect or a memoised handler.
  const fnRef = useRef(fn);
  const optionsRef = useRef(options);
  fnRef.current = fn;
  optionsRef.current = options;

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A second call while the first is in flight is a double click, not an
  // intent. Dropping it here means no caller has to debounce.
  const inFlight = useRef(false);

  const run = useCallback(async (...args: Args): Promise<ActionResult<R>> => {
    if (inFlight.current) return { ok: false, error: "Already running." };
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const data = await fnRef.current(...args);
      const { success, onSuccess } = optionsRef.current;
      if (success) {
        toast.success(typeof success === "function" ? success(data) : success);
      }
      onSuccess?.(data);
      return { ok: true, data };
    } catch (e) {
      const message = humanError(e);
      toast.error(message);
      if (alive.current) setError(message);
      return { ok: false, error: message };
    } finally {
      inFlight.current = false;
      if (alive.current) setPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { run, pending, error, reset };
}
