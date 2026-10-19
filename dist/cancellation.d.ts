/**
 * GitHub Actions job-cancellation wiring (Issues #682 / #683).
 *
 * The runner cancels a running JavaScript step by sending SIGINT (and then
 * SIGTERM) to the process. This module bridges those signals into an
 * `AbortController` so in-flight Horizon requests, `wait_until_funded`
 * polling, batch loops, and comment posting can stop promptly.
 *
 * Listeners are reference-counted per event source, so repeated `run()`
 * invocations (or tests) never accumulate listeners or trigger Node's
 * `MaxListenersExceededWarning`.
 */
type SignalSource = {
    on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};
/**
 * Abort `controller` when the runner sends SIGINT/SIGTERM.
 *
 * @param controller Controller wired into Horizon/polling/batch calls.
 * @param source     Event source (defaults to `process`); injectable for tests.
 * @returns Detach function that removes this controller from the registry.
 */
export declare function attachRunnerCancellation(controller: AbortController, source?: SignalSource): () => void;
export {};
