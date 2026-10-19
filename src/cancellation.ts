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

interface InstalledSource {
  controllers: Set<AbortController>;
  sigint: () => void;
  sigterm: () => void;
}

const installed = new WeakMap<SignalSource, InstalledSource>();

/**
 * Abort `controller` when the runner sends SIGINT/SIGTERM.
 *
 * @param controller Controller wired into Horizon/polling/batch calls.
 * @param source     Event source (defaults to `process`); injectable for tests.
 * @returns Detach function that removes this controller from the registry.
 */
export function attachRunnerCancellation(
  controller: AbortController,
  source: SignalSource = process,
): () => void {
  let entry = installed.get(source);
  if (!entry) {
    const controllers = new Set<AbortController>();
    const abortAll = (message: string): void => {
      for (const active of controllers) {
        if (!active.signal.aborted) {
          active.abort(new Error(message));
        }
      }
    };
    const sigint = (): void =>
      abortAll('Actions runner cancelled the job (SIGINT).');
    const sigterm = (): void =>
      abortAll('Actions runner cancelled the job (SIGTERM).');
    entry = { controllers, sigint, sigterm };
    installed.set(source, entry);
    source.on('SIGINT', sigint);
    source.on('SIGTERM', sigterm);
  }

  entry.controllers.add(controller);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    const current = installed.get(source);
    if (!current) return;
    current.controllers.delete(controller);
    if (current.controllers.size === 0) {
      source.removeListener('SIGINT', current.sigint);
      source.removeListener('SIGTERM', current.sigterm);
      installed.delete(source);
    }
  };
}
