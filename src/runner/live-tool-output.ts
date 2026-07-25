import type { LiveToolOutputSink } from '../tools/types';

/**
 * Deferred-binding relay for live tool output.
 *
 * Tools are built before the stream consumer exists (preparation.ts runs well
 * ahead of processAgentStream), so the tool holds this relay and the consumer
 * binds itself once it starts. Publishes before bind (or after unbind) are
 * dropped rather than buffered: a tail is a live view of a call still running,
 * so there is nothing worth replaying to a consumer that has already gone away.
 */
export interface LiveToolOutputRelay extends LiveToolOutputSink {
  bind(publish: (callID: string, tail: string) => void): void;
  unbind(): void;
}

export function createLiveToolOutputRelay(): LiveToolOutputRelay {
  let sink: ((callID: string, tail: string) => void) | undefined;
  return {
    publish(callID: string, tail: string): void {
      if (!sink) return;
      try {
        sink(callID, tail);
      } catch {
        // A cosmetic preview must never take down the tool that produced it.
      }
    },
    bind(publish: (callID: string, tail: string) => void): void {
      sink = publish;
    },
    unbind(): void {
      sink = undefined;
    },
  };
}
