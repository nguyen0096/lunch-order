import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { useAction } from "@/ui/useAction";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const success = vi.mocked(toast.success);
const error = vi.mocked(toast.error);

beforeEach(() => {
  success.mockClear();
  error.mockClear();
});

/** A promise plus the handles to settle it, so pending can be observed. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAction pending", () => {
  it("is false before the first call", () => {
    const { result } = renderHook(() => useAction(async () => "ok"));
    expect(result.current.pending).toBe(false);
  });

  it("goes true while in flight and false once resolved", async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useAction(() => d.promise));

    let call!: Promise<unknown>;
    act(() => {
      call = result.current.run();
    });
    await waitFor(() => expect(result.current.pending).toBe(true));

    await act(async () => {
      d.resolve("done");
      await call;
    });
    expect(result.current.pending).toBe(false);
  });

  it("returns to false after a failure", async () => {
    const { result } = renderHook(() =>
      useAction(async () => {
        throw new Error("nope");
      }),
    );
    await act(async () => {
      await result.current.run();
    });
    expect(result.current.pending).toBe(false);
  });

  it("drops a second call made while the first is in flight", async () => {
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);
    const { result } = renderHook(() => useAction(fn));

    let first!: Promise<unknown>;
    act(() => {
      first = result.current.run();
    });
    await act(async () => {
      await result.current.run();
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve("done");
      await first;
    });
  });
});

describe("useAction success", () => {
  it("toasts the configured word", async () => {
    const { result } = renderHook(() =>
      useAction(async () => ({ id: 1 }), { success: "Published" }),
    );
    await act(async () => {
      await result.current.run();
    });
    expect(success).toHaveBeenCalledWith("Published");
    expect(error).not.toHaveBeenCalled();
  });

  it("lets the sentence read the result", async () => {
    const { result } = renderHook(() =>
      useAction(async () => 3, { success: (n) => `Published ${n} dishes` }),
    );
    await act(async () => {
      await result.current.run();
    });
    expect(success).toHaveBeenCalledWith("Published 3 dishes");
  });

  it("passes arguments through and returns the result", async () => {
    const fn = vi.fn(async (a: number, b: number) => a + b);
    const { result } = renderHook(() => useAction(fn));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.run(2, 3);
    });
    expect(fn).toHaveBeenCalledWith(2, 3);
    expect(outcome).toEqual({ ok: true, data: 5 });
  });

  it("runs onSuccess only when the write succeeded", async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useAction(async () => {
        throw new Error("no");
      }, { onSuccess }),
    );
    await act(async () => {
      await result.current.run();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("stays silent when no success word is configured", async () => {
    const { result } = renderHook(() => useAction(async () => "x"));
    await act(async () => {
      await result.current.run();
    });
    expect(success).not.toHaveBeenCalled();
  });
});

describe("useAction failure", () => {
  it("toasts the database's own message verbatim", async () => {
    const { result } = renderHook(() =>
      useAction(async () => {
        throw { message: "Ordering closed at 21:00", code: "P0001" };
      }),
    );
    await act(async () => {
      await result.current.run();
    });
    expect(error).toHaveBeenCalledWith("Ordering closed at 21:00");
  });

  it("uses humanError's rewrite for a row-level-security refusal", async () => {
    const { result } = renderHook(() =>
      useAction(async () => {
        throw { message: "new row violates row-level security policy", code: "42501" };
      }),
    );
    await act(async () => {
      await result.current.run();
    });
    expect(error).toHaveBeenCalledWith("You don't have permission to do that.");
  });

  it("names a server misconfiguration as not the user's fault", async () => {
    const { result } = renderHook(() =>
      useAction(async () => {
        throw { message: "permission denied for function place_order" };
      }),
    );
    await act(async () => {
      await result.current.run();
    });
    expect(error).toHaveBeenCalledWith(
      "Server misconfiguration: permission denied for function place_order. This is not something you did.",
    );
  });

  it("falls back to a sentence when the error carries no message", async () => {
    const { result } = renderHook(() =>
      useAction(async () => {
        throw null;
      }),
    );
    await act(async () => {
      await result.current.run();
    });
    expect(error).toHaveBeenCalledWith("Something went wrong. Try again.");
  });

  it("resolves rather than rejects, so no caller needs try/catch", async () => {
    const { result } = renderHook(() =>
      useAction(async () => {
        throw new Error("boom");
      }),
    );
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.run();
    });
    expect(outcome).toEqual({ ok: false, error: "boom" });
  });

  it("exposes the message for a screen that also wants it inline, and clears it", async () => {
    const { result } = renderHook(() =>
      useAction(async () => {
        throw new Error("boom");
      }),
    );
    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).toBe("boom");
    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
  });
});
