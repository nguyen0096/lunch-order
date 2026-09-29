import userEvent from "@testing-library/user-event";

/**
 * user-event for a file that runs on `vi.useFakeTimers({ shouldAdvanceTime: true })`.
 *
 * user-event pauses on `setTimeout(delay)` between every keystroke and click.
 * Under fake timers that timeout only fires when the fake clock moves, and
 * `shouldAdvanceTime` moves it one 20ms tick of real time at a time, so each
 * action costs at least a tick and far more on a busy machine: a 50-character
 * `type` spent over a second waiting and ran past the 5s test limit. Handing
 * user-event the clock lets it advance the fake time itself, as its docs ask.
 *
 * Call it after the fake timers are installed, inside the test or a
 * `beforeEach`.
 */
export function fakeClockUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}
