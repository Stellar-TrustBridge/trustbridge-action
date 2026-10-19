import { EventEmitter } from 'events';
import { attachRunnerCancellation } from '../src/cancellation';

class SignalSource extends EventEmitter {
  exitCode: number | string | null | undefined;
}

describe('attachRunnerCancellation (Issue #682)', () => {
  it('aborts the controller on SIGINT', () => {
    const source = new SignalSource();
    const controller = new AbortController();
    const detach = attachRunnerCancellation(controller, source);

    source.emit('SIGINT');

    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toContain('SIGINT');
    detach();
  });

  it('aborts the controller on SIGTERM', () => {
    const source = new SignalSource();
    const controller = new AbortController();
    const detach = attachRunnerCancellation(controller, source);

    source.emit('SIGTERM');

    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toContain('SIGTERM');
    detach();
  });

  it('shares one pair of listeners across controllers and cleans up', () => {
    const source = new SignalSource();
    const first = new AbortController();
    const second = new AbortController();

    const detachFirst = attachRunnerCancellation(first, source);
    const detachSecond = attachRunnerCancellation(second, source);
    expect(source.listenerCount('SIGINT')).toBe(1);
    expect(source.listenerCount('SIGTERM')).toBe(1);

    source.emit('SIGINT');
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);

    detachFirst();
    expect(source.listenerCount('SIGINT')).toBe(1);
    detachSecond();
    expect(source.listenerCount('SIGINT')).toBe(0);
    expect(source.listenerCount('SIGTERM')).toBe(0);
  });

  it('is idempotent when detached twice', () => {
    const source = new SignalSource();
    const controller = new AbortController();
    const detach = attachRunnerCancellation(controller, source);

    detach();
    detach();

    expect(source.listenerCount('SIGINT')).toBe(0);
  });
});
