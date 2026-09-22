import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initClock } from "../shared/clock.js";
import { allParams } from "./useHashRoute.js";
import { configError } from "./supabase.js";
import { Button, Toaster, TooltipProvider } from "@/ui";
import "./styles.css";

/**
 * Anything that reaches here would otherwise be a blank page with the reason
 * buried in the console. Showing it costs nothing and saves the next person
 * half an hour.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <Centered heading="Something broke">
          <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
            {this.state.error.message}
          </p>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </Centered>
      );
    }
    return this.props.children;
  }
}

/** The prose-shaped screens: a readable measure, not the full width. */
function Centered({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-prose flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-semibold">{heading}</h1>
      {children}
    </main>
  );
}

// Accepts ?now= before or inside the hash, since both get typed.
const fakeNow = initClock(allParams().toString());

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");

createRoot(el).render(
  configError ? (
    <Centered heading="Not configured">
      <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-subtle-fg">
        {configError}
      </p>
    </Centered>
  ) : (
    <StrictMode>
      {/* One toast surface and one tooltip provider for the whole app. Two of
          either is how a screen ends up with its own reporting channel. */}
      <TooltipProvider>
        <ErrorBoundary>
          {/* A shifted clock must never be mistaken for a bug, so say so loudly. */}
          {fakeNow && (
            <div className="bg-warn-subtle px-4 py-2 text-center text-sm text-warn-subtle-fg">
              Pretending it is {fakeNow}. The database still enforces the real cutoff.
            </div>
          )}
          <App />
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </StrictMode>
  ),
);
