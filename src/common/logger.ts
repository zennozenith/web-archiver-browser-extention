/**
 * logger.ts: zero-dependency, colorized logger for browser extensions
 * (Chrome / Edge / Firefox / Safari, MV2 + MV3).
 *
 * Features
 *  - Levels: trace < debug < info < warn < error < silent
 *  - Colored output via console `%c` CSS (badge per level, stable color per namespace)
 *  - Auto-detected extension context tag (background, content, popup, options, ...)
 *  - Child loggers with namespaces:  log.child('api')  ->  "app:api"
 *  - Per-namespace level rules with wildcards:  setNamespaceLevel('app:api*', 'debug')
 *  - Runtime level changes, persisted in storage.local and synced live across contexts
 *  - Pluggable transports: console, memory ring buffer, storage (survives MV3 worker restarts),
 *    forward-to-background (see content script logs in the service worker console)
 *  - Safe serialization: circular refs, Errors, Map/Set, DOM nodes, BigInt, secret redaction
 *  - Lazy args: log.debug(() => expensive()) only runs if the level is enabled
 *  - Timers, global error capture, text export
 *  - Built on `webextension-polyfill` (promise-based, typed `browser` API); never throws
 *
 * Quick start
 * ------------
 *   // shared.ts
 *   import { createLogger, captureGlobalErrors } from './logger';
 *   export const log = createLogger({
 *     namespace: 'my-ext',
 *     storeLogs: { maxEntries: 500 },   // optional: needs "storage" permission
 *     forwardToBackground: true,        // optional: content/popup -> background console
 *     expose: 'logger',                 // optional: window.logger.setLevel('trace') from DevTools
 *   });
 *   captureGlobalErrors(log);
 *
 *   // background.ts (only if you use forwardToBackground)
 *   import { log } from './shared';
 *   import { receiveForwardedLogs } from './logger';
 *   receiveForwardedLogs(log);
 *
 *   // anywhere
 *   const api = log.child('api');
 *   api.info('fetching', { url });
 *   api.error('failed', new Error('boom'));
 *   const done = api.time('request'); await fetch(url); done();
 */

import browser from "webextension-polyfill";

/* ───────────────────────────── Types ───────────────────────────── */

export type LevelName = "trace" | "debug" | "info" | "warn" | "error";
export type LevelSetting = LevelName | "silent";

export const LEVELS: Readonly<Record<LevelSetting, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

export interface LogEntry {
  time: number;
  level: LevelName;
  namespace: string;
  context: string;
  args: unknown[];
}

export interface SerializedEntry {
  time: number;
  level: LevelName;
  namespace: string;
  context: string;
  message: string;
  data: unknown[];
}

export interface Transport {
  write(entry: LogEntry): void;
  flush?(): void | Promise<void>;
}

const isLevelSetting = (v: unknown): v is LevelSetting =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(LEVELS, v);

/* ───────────────────── Extension API helpers ───────────────────── */

const G = globalThis as any;

const hasStorage = (): boolean => {
  try {
    return !!browser.storage?.local;
  } catch {
    return false;
  }
};

async function storageGetRaw(keys: string | string[] | null): Promise<Record<string, unknown>> {
  try {
    return (await browser.storage.local.get(keys)) ?? {};
  } catch {
    return {};
  }
}

async function storageSet(items: Record<string, unknown>): Promise<void> {
  try {
    await browser.storage.local.set(items);
  } catch {
    /* storage permission missing or quota exceeded */
  }
}

async function storageRemove(keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    await browser.storage.local.remove(keys);
  } catch {
    /* ignore */
  }
}

/** Best-effort: unpacked / dev-loaded Chrome extensions have no `update_url` in the manifest. */
export function isDevBuild(): boolean {
  try {
    return !("update_url" in browser.runtime.getManifest());
  } catch {
    return false;
  }
}

/** Detects which part of the extension this code is running in. */
export function detectContext(): string {
  const w = G as any;
  if (
    typeof w.ServiceWorkerGlobalScope !== "undefined" &&
    w.self instanceof w.ServiceWorkerGlobalScope
  ) {
    return "background";
  }
  if (typeof w.WorkerGlobalScope !== "undefined" && w.self instanceof w.WorkerGlobalScope)
    return "worker";
  if (typeof w.window === "undefined") return "unknown";

  const proto: string = w.location?.protocol ?? "";
  if (/^(chrome|moz|safari-web|ms-browser)-extension:$/.test(proto)) {
    const p = String(w.location.pathname).toLowerCase();
    if (p.includes("background")) return "background";
    if (p.includes("popup")) return "popup";
    if (p.includes("option")) return "options";
    if (/side[-_]?(panel|bar)/.test(p)) return "sidepanel";
    if (p.includes("devtools")) return "devtools";
    if (p.includes("offscreen")) return "offscreen";
    return "page";
  }
  return "content";
}

/* ───────────────────────── Serialization ───────────────────────── */

const SECRET_KEY =
  /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|session|credential/i;
const MAX_DEPTH = 6;
const MAX_STRING = 5000;
const MAX_KEYS = 100;

export function serialize(
  value: unknown,
  redact = true,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  try {
    if (value === null || value === undefined) return value;
    switch (typeof value) {
      case "string":
        return value.length > MAX_STRING
          ? value.slice(0, MAX_STRING) + `…[+${value.length - MAX_STRING}]`
          : value;
      case "number":
        return Number.isFinite(value) ? value : String(value);
      case "boolean":
        return value;
      case "bigint":
        return `${value}n`;
      case "symbol":
        return value.toString();
      case "function":
        return `[Function ${(value as Function).name || "anonymous"}]`;
    }

    const obj = value as object;
    if (seen.has(obj)) return "[Circular]";
    if (depth >= MAX_DEPTH) return Array.isArray(obj) ? "[Array]" : "[Object]";
    seen.add(obj);

    if (obj instanceof Error) {
      const e: Record<string, unknown> = { name: obj.name, message: obj.message, stack: obj.stack };
      if ("cause" in obj) e.cause = serialize((obj as any).cause, redact, depth + 1, seen);
      return e;
    }
    if (obj instanceof Date) return isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
    if (obj instanceof RegExp) return obj.toString();
    if (typeof Node !== "undefined" && obj instanceof Node) {
      const el = obj as Element;
      return el.nodeType === 1
        ? `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${
            typeof el.className === "string" && el.className
              ? "." + el.className.trim().split(/\s+/).join(".")
              : ""
          }>`
        : `[Node ${obj.nodeName}]`;
    }
    if (obj instanceof Map) {
      return {
        __type: "Map",
        entries: [...obj.entries()]
          .slice(0, MAX_KEYS)
          .map(([k, v]) => [
            serialize(k, redact, depth + 1, seen),
            serialize(v, redact, depth + 1, seen),
          ]),
      };
    }
    if (obj instanceof Set) {
      return {
        __type: "Set",
        values: [...obj.values()]
          .slice(0, MAX_KEYS)
          .map((v) => serialize(v, redact, depth + 1, seen)),
      };
    }
    if (ArrayBuffer.isView(obj)) return `[${obj.constructor.name} ${obj.byteLength}B]`;
    if (obj instanceof ArrayBuffer) return `[ArrayBuffer ${obj.byteLength}B]`;
    if (Array.isArray(obj))
      return obj.slice(0, MAX_KEYS).map((v) => serialize(v, redact, depth + 1, seen));

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).slice(0, MAX_KEYS)) {
      if (redact && SECRET_KEY.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      try {
        out[key] = serialize((obj as any)[key], redact, depth + 1, seen);
      } catch {
        out[key] = "[Unreadable]";
      }
    }
    return out;
  } catch {
    return "[Unserializable]";
  }
}

function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  const s = serialize(a, false);
  if (typeof s === "string") return s;
  try {
    return JSON.stringify(s) ?? String(s);
  } catch {
    return String(s);
  }
}

export function serializeEntry(e: LogEntry, redact = true): SerializedEntry {
  const data = e.args.map((a) => serialize(a, redact));
  return {
    time: e.time,
    level: e.level,
    namespace: e.namespace,
    context: e.context,
    message: data.map(stringifyArg).join(" "),
    data,
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function formatClock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Plain-text line for a stored entry (for export / copy-paste). */
export function formatEntry(e: SerializedEntry): string {
  return `${new Date(e.time).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.context}]${
    e.namespace ? " " + e.namespace : ""
  } ${e.message}`;
}

/* ───────────────────────────── Colors ───────────────────────────── */

const LEVEL_BADGE: Record<LevelName, string> = {
  trace: "background:#6b7280;color:#fff",
  debug: "background:#3b82f6;color:#fff",
  info: "background:#10b981;color:#fff",
  warn: "background:#f59e0b;color:#000",
  error: "background:#ef4444;color:#fff",
};
const BADGE_BASE = "font-weight:bold;border-radius:3px;";
const STYLE_DIM = "color:#9ca3af";
const STYLE_CTX = "color:#8b5cf6;font-style:italic";

const nsStyleCache = new Map<string, string>();
function namespaceStyle(ns: string): string {
  let s = nsStyleCache.get(ns);
  if (!s) {
    let h = 5381;
    for (let i = 0; i < ns.length; i++) h = ((h << 5) + h + ns.charCodeAt(i)) | 0;
    s = `color:hsl(${Math.abs(h) % 360},70%,55%);font-weight:bold`;
    nsStyleCache.set(ns, s);
  }
  return s;
}

/* ─────────────────────────── Transports ────────────────────────── */

// debug -> console.log on purpose: Chrome hides console.debug unless "Verbose" is enabled,
// and we already filter by level ourselves.
const CONSOLE_METHOD: Record<LevelName, "debug" | "log" | "info" | "warn" | "error"> = {
  trace: "debug",
  debug: "log",
  info: "info",
  warn: "warn",
  error: "error",
};

export interface ConsoleTransportOptions {
  colors?: boolean;
  timestamps?: boolean;
  showContext?: boolean;
}

export class ConsoleTransport implements Transport {
  constructor(private readonly opts: ConsoleTransportOptions = {}) {}

  write(e: LogEntry): void {
    const { colors = true, timestamps = true, showContext = true } = this.opts;
    const segs: Array<[text: string, style: string]> = [];
    if (timestamps) segs.push([formatClock(e.time), STYLE_DIM]);
    segs.push([` ${e.level.toUpperCase().padEnd(5)} `, BADGE_BASE + LEVEL_BADGE[e.level]]);
    if (showContext) segs.push([e.context, STYLE_CTX]);
    if (e.namespace) segs.push([e.namespace, namespaceStyle(e.namespace)]);

    const method = console[CONSOLE_METHOD[e.level]] ?? console.log;
    const esc = (s: string) => s.replace(/%/g, "%%");

    if (colors) {
      method.call(
        console,
        segs.map(([t]) => "%c" + esc(t)).join(" "),
        ...segs.map(([, s]) => s),
        ...e.args,
      );
    } else {
      const prefix = segs.map(([t]) => t).join(" ");
      method.call(console, e.args.length ? esc(prefix) : prefix, ...e.args);
    }
  }
}

/** Keeps the last N entries in memory. Handy for "copy debug info" buttons. */
export class MemoryTransport implements Transport {
  private buf: SerializedEntry[] = [];
  constructor(private readonly max = 1000) {}

  write(e: LogEntry): void {
    this.buf.push(serializeEntry(e));
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
  }
  entries(): SerializedEntry[] {
    return this.buf.slice();
  }
  text(): string {
    return this.buf.map(formatEntry).join("\n");
  }
  clear(): void {
    this.buf = [];
  }
}

const STORAGE_PREFIX = "__logger:logs:";
const CONFIG_KEY = "__logger:config";

export interface StorageTransportOptions {
  context: string;
  maxEntries?: number;
  flushDelayMs?: number;
  minLevel?: LevelName;
}

/**
 * Persists a capped ring buffer in storage.local, one key per context (avoids cross-context
 * write races). Survives MV3 service-worker restarts. warn/error are flushed immediately
 * because the worker may be killed at any time.
 */
export class StorageTransport implements Transport {
  private buffer: SerializedEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly key: string;
  private readonly max: number;
  private readonly delay: number;
  private readonly minLevel: number;
  private readonly ready: Promise<void>;

  constructor(opts: StorageTransportOptions) {
    this.key = STORAGE_PREFIX + opts.context;
    this.max = opts.maxEntries ?? 500;
    this.delay = opts.flushDelayMs ?? 750;
    this.minLevel = LEVELS[opts.minLevel ?? "debug"];
    this.ready = storageGetRaw(this.key).then((res) => {
      const prev = res[this.key];
      if (Array.isArray(prev))
        this.buffer = (prev as SerializedEntry[]).concat(this.buffer).slice(-this.max);
    });
  }

  write(e: LogEntry): void {
    if (LEVELS[e.level] < this.minLevel) return;
    this.buffer.push(serializeEntry(e));
    if (this.buffer.length > this.max) this.buffer.splice(0, this.buffer.length - this.max);
    if (LEVELS[e.level] >= LEVELS.warn) {
      void this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => void this.flush(), this.delay);
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.ready;
    await storageSet({ [this.key]: this.buffer.slice() });
  }
}

/** Read persisted logs from every context, oldest first. */
export async function readStoredLogs(): Promise<SerializedEntry[]> {
  const all = await storageGetRaw(null);
  const out: SerializedEntry[] = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(STORAGE_PREFIX) && Array.isArray(v)) out.push(...(v as SerializedEntry[]));
  }
  return out.sort((a, b) => a.time - b.time);
}

export async function exportStoredLogs(): Promise<string> {
  return (await readStoredLogs()).map(formatEntry).join("\n");
}

export async function clearStoredLogs(): Promise<void> {
  const all = await storageGetRaw(null);
  await storageRemove(Object.keys(all).filter((k) => k.startsWith(STORAGE_PREFIX)));
}

const FORWARD_FLAG = "__extLogger";

/** Sends entries to the background via runtime messaging. Pair with `receiveForwardedLogs`. */
export class ForwardTransport implements Transport {
  constructor(private readonly minLevel: LevelName = "info") {}

  write(e: LogEntry): void {
    if (LEVELS[e.level] < LEVELS[this.minLevel]) return;
    try {
      // Rejects when no receiver is listening (e.g. background asleep); that's fine.
      browser.runtime.sendMessage({ [FORWARD_FLAG]: 1, entry: serializeEntry(e) }).catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

/** Call in the background script: replays forwarded entries through the given logger. */
export function receiveForwardedLogs(logger: Logger): () => void {
  const handler = (msg: any, sender: { tab?: { id?: number } }) => {
    if (!msg || msg[FORWARD_FLAG] !== 1 || !msg.entry) return undefined; // not ours; don't claim response
    const e = msg.entry as SerializedEntry;
    const tab = sender?.tab?.id;
    logger.ingest({
      time: e.time,
      level: e.level,
      namespace: e.namespace,
      context: tab != null ? `${e.context}#${tab}` : e.context,
      args: Array.isArray(e.data) ? e.data : [e.message],
    });
    return undefined;
  };
  browser.runtime.onMessage.addListener(handler);
  return () => browser.runtime.onMessage.removeListener(handler);
}

/* ────────────────────────────── Core ───────────────────────────── */

interface PersistedConfig {
  level?: LevelSetting;
  namespaces?: Record<string, LevelSetting>;
}

class Core {
  level: LevelSetting;
  readonly rules = new Map<string, { re: RegExp; level: LevelSetting }>();
  private cache = new Map<string, number>();

  constructor(
    level: LevelSetting,
    readonly context: string,
    readonly transports: Transport[],
  ) {
    this.level = level;
  }

  threshold(ns: string): number {
    let t = this.cache.get(ns);
    if (t === undefined) {
      t = LEVELS[this.level];
      const rules = [...this.rules.values()];
      for (let i = rules.length - 1; i >= 0; i--) {
        if (rules[i].re.test(ns)) {
          t = LEVELS[rules[i].level];
          break;
        }
      }
      this.cache.set(ns, t);
    }
    return t;
  }

  invalidate(): void {
    this.cache.clear();
  }

  setRule(pattern: string, level: LevelSetting): void {
    const re = new RegExp(
      "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    this.rules.set(pattern, { re, level });
    this.invalidate();
  }

  apply(cfg: PersistedConfig | undefined): void {
    if (!cfg || typeof cfg !== "object") return;
    if (isLevelSetting(cfg.level)) this.level = cfg.level;
    this.rules.clear();
    for (const [p, l] of Object.entries(cfg.namespaces ?? {}))
      if (isLevelSetting(l)) this.setRule(p, l);
    this.invalidate();
  }

  toConfig(): PersistedConfig {
    const namespaces: Record<string, LevelSetting> = {};
    this.rules.forEach((r, p) => (namespaces[p] = r.level));
    return { level: this.level, namespaces };
  }

  dispatch(entry: LogEntry): void {
    for (const t of this.transports) {
      try {
        t.write(entry);
      } catch {
        /* a broken transport must never break the app or recurse into logging */
      }
    }
  }
}

/* ───────────────────────────── Logger ──────────────────────────── */

type LogArgs = unknown[];

export class Logger {
  /** @internal */
  constructor(
    private readonly core: Core,
    readonly namespace: string,
  ) {}

  trace(...args: LogArgs): void {
    this.emit("trace", args);
  }
  debug(...args: LogArgs): void {
    this.emit("debug", args);
  }
  info(...args: LogArgs): void {
    this.emit("info", args);
  }
  warn(...args: LogArgs): void {
    this.emit("warn", args);
  }
  error(...args: LogArgs): void {
    this.emit("error", args);
  }

  /** Child logger: `app` -> `app:api`. Shares level, rules and transports. */
  child(name: string): Logger {
    return new Logger(this.core, this.namespace ? `${this.namespace}:${name}` : name);
  }

  isEnabled(level: LevelName): boolean {
    return LEVELS[level] >= this.core.threshold(this.namespace);
  }

  /** Returns a stop function that logs the elapsed time. */
  time(label: string, level: LevelName = "debug"): (...extra: unknown[]) => number {
    const start = performance.now();
    return (...extra) => {
      const ms = performance.now() - start;
      this[level](`${label} took ${ms.toFixed(1)}ms`, ...extra);
      return ms;
    };
  }

  /** Global level. Persisted and synced across extension contexts unless `persist` is false. */
  setLevel(level: LevelSetting, persist = true): void {
    if (!isLevelSetting(level)) return;
    this.core.level = level;
    this.core.invalidate();
    if (persist) void this.persist();
  }

  getLevel(): LevelSetting {
    return this.core.level;
  }

  /** e.g. setNamespaceLevel('my-ext:api*', 'trace'). `*` is a wildcard; last rule added wins. */
  setNamespaceLevel(pattern: string, level: LevelSetting, persist = true): void {
    if (!isLevelSetting(level)) return;
    this.core.setRule(pattern, level);
    if (persist) void this.persist();
  }

  clearNamespaceLevels(persist = true): void {
    this.core.rules.clear();
    this.core.invalidate();
    if (persist) void this.persist();
  }

  addTransport(t: Transport): void {
    this.core.transports.push(t);
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.core.transports.map((t) => Promise.resolve(t.flush?.()).catch(() => {})),
    );
  }

  /** Dispatch a pre-built entry (e.g. forwarded from another context) without level filtering. */
  ingest(entry: LogEntry): void {
    this.core.dispatch(entry);
  }

  private async persist(): Promise<void> {
    await storageSet({ [CONFIG_KEY]: this.core.toConfig() });
  }

  private emit(level: LevelName, args: LogArgs): void {
    const core = this.core;
    if (LEVELS[level] < core.threshold(this.namespace)) return;

    if (args.length === 1 && typeof args[0] === "function") {
      try {
        args = [(args[0] as () => unknown)()];
      } catch (err) {
        args = ["[log thunk threw]", err];
      }
    }
    core.dispatch({
      time: Date.now(),
      level,
      namespace: this.namespace,
      context: core.context,
      args,
    });
  }
}

/* ───────────────────────────── Factory ─────────────────────────── */

export interface LoggerOptions {
  /** Root namespace, usually your extension name. */
  namespace?: string;
  /** Initial level. Default: 'debug' for unpacked builds, 'info' otherwise. A persisted level overrides it. */
  level?: LevelSetting;
  /** Override the auto-detected context tag. */
  context?: string;
  /** Replace the default transports entirely. */
  transports?: Transport[];
  /** Console output tweaks for the default console transport. */
  console?: ConsoleTransportOptions;
  /** Persist logs to storage.local (needs the "storage" permission). */
  storeLogs?: boolean | { maxEntries?: number; minLevel?: LevelName };
  /** Forward logs to the background console (call `receiveForwardedLogs` there). */
  forwardToBackground?: boolean | { minLevel?: LevelName };
  /** Load/persist level config in storage.local and sync it live across contexts. Default: true. */
  persistConfig?: boolean;
  /** Attach the logger to globalThis under this name for DevTools use. */
  expose?: string;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const context = options.context ?? detectContext();
  const transports: Transport[] = options.transports
    ? [...options.transports]
    : [new ConsoleTransport(options.console)];

  if (!options.transports) {
    if (options.storeLogs) {
      const o = typeof options.storeLogs === "object" ? options.storeLogs : {};
      transports.push(new StorageTransport({ context, ...o }));
    }
    if (options.forwardToBackground && context !== "background") {
      const o = typeof options.forwardToBackground === "object" ? options.forwardToBackground : {};
      transports.push(new ForwardTransport(o.minLevel));
    }
  }

  const core = new Core(options.level ?? (isDevBuild() ? "debug" : "info"), context, transports);
  const logger = new Logger(core, options.namespace ?? "");

  if (options.persistConfig !== false && hasStorage()) {
    // Load saved config (logs emitted before this resolves use the default level).
    void storageGetRaw(CONFIG_KEY).then((res) => core.apply(res[CONFIG_KEY] as PersistedConfig));
    // Live-sync level changes made in any other context.
    try {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[CONFIG_KEY])
          core.apply(changes[CONFIG_KEY].newValue as PersistedConfig);
      });
    } catch {
      /* ignore */
    }
  }

  if (options.expose) (G as any)[options.expose] = logger;
  return logger;
}

/* ──────────────────────── Global error capture ─────────────────── */

/** Logs uncaught errors and unhandled promise rejections. Returns an uninstall function. */
export function captureGlobalErrors(logger: Logger): () => void {
  const target: any = G.self ?? G;
  if (typeof target?.addEventListener !== "function") return () => {};
  const log = logger.child("global");

  const onError = (e: ErrorEvent) =>
    log.error(
      "Uncaught error:",
      e.error ?? e.message,
      e.filename ? `(${e.filename}:${e.lineno}:${e.colno})` : "",
    );
  const onRejection = (e: PromiseRejectionEvent) =>
    log.error("Unhandled promise rejection:", e.reason);

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
