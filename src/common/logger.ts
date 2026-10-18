/**
 * simple-logger.ts: minimal colorized logger, zero dependencies.
 *
 *   const log = createLogger('my-ext');
 *   log.info('started', { version: 1 });
 *   log.child('api').error('failed', new Error('boom'));
 *   log.setLevel('debug');
 */

export type Level = "debug" | "info" | "warn" | "error" | "silent";

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

const BADGE: Record<Exclude<Level, "silent">, string> = {
  debug: "background:#3b82f6;color:#fff",
  info: "background:#10b981;color:#fff",
  warn: "background:#f59e0b;color:#000",
  error: "background:#ef4444;color:#fff",
};

const METHOD = { debug: "log", info: "info", warn: "warn", error: "error" } as const;

// Stable color per namespace, derived from a hash of its name.
function nsColor(ns: string): string {
  let h = 0;
  for (let i = 0; i < ns.length; i++) h = (h * 31 + ns.charCodeAt(i)) % 360;
  return `color:hsl(${h},70%,55%);font-weight:bold`;
}

export class Logger {
  constructor(
    readonly namespace: string,
    private state = { level: "debug" as Level },
  ) {}

  debug = (...args: unknown[]) => this.log("debug", args);
  info = (...args: unknown[]) => this.log("info", args);
  warn = (...args: unknown[]) => this.log("warn", args);
  error = (...args: unknown[]) => this.log("error", args);

  /** Child shares the parent's level: `app` -> `app:api`. */
  child(name: string): Logger {
    return new Logger(this.namespace ? `${this.namespace}:${name}` : name, this.state);
  }

  setLevel(level: Level): void {
    this.state.level = level;
  }

  private log(level: Exclude<Level, "silent">, args: unknown[]): void {
    if (RANK[level] < RANK[this.state.level]) return;

    const time = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const badge = ` ${level.toUpperCase().padEnd(5)} `;
    const ns = this.namespace.replace(/%/g, "%%");

    console[METHOD[level]](
      `%c${time}%c${badge}%c${ns ? " " + ns : ""}`,
      "color:#9ca3af",
      `font-weight:bold;border-radius:3px;${BADGE[level]}`,
      nsColor(this.namespace),
      ...args,
    );
  }
}

export const createLogger = (namespace = "", level: Level = "debug"): Logger =>
  new Logger(namespace, { level });
