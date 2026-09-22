import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initClock } from "../shared/clock.js";
import { allParams } from "./useHashRoute.js";
import { configError } from "./supabase.js";
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
        <main className="center">
          <h1>Something broke</h1>
          <p className="notice error">{this.state.error.message}</p>
          <button className="btn" onClick={() => window.location.reload()}>Reload</button>
        </main>
      );
    }
    return this.props.children;
  }
}

// Accepts ?now= before or inside the hash, since both get typed.
const fakeNow = initClock(allParams().toString());

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");

createRoot(el).render(
  configError ? (
    <main className="center">
      <h1>Not configured</h1>
      <p className="notice error">{configError}</p>
    </main>
  ) : (
    <StrictMode>
      <ErrorBoundary>
        {/* A shifted clock must never be mistaken for a bug, so say so loudly. */}
        {fakeNow && (
          <div className="clock-banner">
            Pretending it is {fakeNow}. The database still enforces the real cutoff.
          </div>
        )}
        <App />
      </ErrorBoundary>
    </StrictMode>
  ),
);
