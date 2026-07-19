import { logger, withoutLogSink } from '../utils/logger';

export interface TerminalToolResultOptions {
  duration?: number;
  success?: boolean;
  tokens?: number;
}

/**
 * Ephemeral presentation of normalized run events.
 *
 * Terminal output is a renderer, not durable session history. Every call runs
 * outside the operational-log sink so presentation lines can never become
 * duplicate `type: "log"` parts beside the structured event they render.
 */
export interface TerminalPresenter {
  text(delta: string): void;
  responseComplete(): void;
  llmStarted(model: string): void;
  llmFirstToken(model: string, latencyMs: number): void;
  toolStarted(name: string, input: unknown, isSubAgent?: boolean): void;
  toolFinished(result: unknown, options?: TerminalToolResultOptions): void;
  warning(message: string): void;
}

export class LoggerTerminalPresenter implements TerminalPresenter {
  private render(action: () => void): void {
    withoutLogSink(action);
  }

  text(delta: string): void {
    this.render(() => logger.response(delta));
  }

  responseComplete(): void {
    this.render(() => logger.responseComplete());
  }

  llmStarted(model: string): void {
    this.render(() => logger.llmStart(model));
  }

  llmFirstToken(model: string, latencyMs: number): void {
    this.render(() => logger.llmFirstToken(model, latencyMs));
  }

  toolStarted(name: string, input: unknown, isSubAgent?: boolean): void {
    this.render(() => logger.tool(name, input, undefined, isSubAgent));
  }

  toolFinished(result: unknown, options?: TerminalToolResultOptions): void {
    this.render(() => logger.toolResult(result, options));
  }

  warning(message: string): void {
    this.render(() => logger.warn(message));
  }
}

export const defaultTerminalPresenter: TerminalPresenter = new LoggerTerminalPresenter();
