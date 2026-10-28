// Run log: one JSON object per line, to logs/<runId>.jsonl and to stdout.
// Every agent step, model call, SQL statement and critic verdict goes through here.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface LogEvent {
  readonly agent: string;
  readonly step: string;
  readonly [field: string]: unknown;
}

export interface RunLogger {
  readonly runId: string;
  readonly file: string;
  log(event: LogEvent): void;
}

export interface LoggerOptions {
  readonly dir?: string;
  readonly runId?: string;
  readonly clock?: () => Date;
  readonly echo?: (line: string) => void;
}

/** Receives every event as it is logged, from any run in this process. */
export type LogListener = (record: Readonly<Record<string, unknown>>) => void;

const listeners = new Set<LogListener>();

/**
 * Calls listener with every event logged from now on, so the web server can show
 * a run's SQL on the page while it happens. Returns the function that stops it.
 */
export function onLogEvent(listener: LogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function newRunId(clock: () => Date = () => new Date()): string {
  const stamp = clock().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export function createRunLogger(options: LoggerOptions = {}): RunLogger {
  const clock = options.clock ?? (() => new Date());
  const runId = options.runId ?? newRunId(clock);
  const dir = options.dir ?? "logs";
  const echo = options.echo ?? ((line: string) => process.stdout.write(`${line}\n`));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.jsonl`);
  return {
    runId,
    file,
    log(event: LogEvent): void {
      const record = { ts: clock().toISOString(), runId, ...event };
      const line = JSON.stringify(record);
      appendFileSync(file, `${line}\n`, "utf8");
      echo(line);
      for (const listener of listeners) {
        try {
          listener(record);
        } catch (error: unknown) {
          // A page that stopped listening must not stop the run.
          process.stderr.write(`Log listener failed: ${(error as Error).message}\n`);
        }
      }
    },
  };
}
