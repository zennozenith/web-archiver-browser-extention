/**
 * Type-safe custom event system for the browser.
 *
 * - Strongly typed event names and payloads via an event map
 * - Wildcard listeners: "cart:*" (namespace) and "*" (everything)
 * - Listener priorities (higher runs first, ties run in subscribe order)
 * - emit (sync), emitAsync (Promise.all), emitSerial (awaited one by one)
 * - once / off / waitFor, AbortSignal cleanup
 * - A throwing listener never breaks other listeners (sync emit)
 * - Optional bridge to the DOM (EventTarget / CustomEvent)
 */

export type EventMap = object;

type Key<E extends EventMap> = keyof E & string;

/** "cart:*" style patterns derived from the "namespace:name" keys in E, plus "*". */
type Namespaces<E extends EventMap> = {
  [K in Key<E>]: K extends `${infer P}:${string}` ? `${P}:*` : never;
}[Key<E>];
export type Pattern<E extends EventMap> = "*" | Namespaces<E>;

/** Event names that a given pattern matches. */
type Matching<E extends EventMap, P extends string> = P extends "*"
  ? Key<E>
  : P extends `${infer Pre}*`
    ? Extract<Key<E>, `${Pre}${string}`>
    : never;

/** Listeners receive the payload and the concrete event type that fired. */
export type Listener<T, K extends string = string> = (payload: T, type: K) => unknown;

export interface ListenerOptions {
  /** Remove the listener automatically after the first call. */
  once?: boolean;
  /** Remove the listener when this signal aborts. */
  signal?: AbortSignal;
  /** Higher numbers run first. Default 0. */
  priority?: number;
}

type Unsubscribe = () => void;

interface Entry {
  pattern: string;
  fn: Listener<any, any>;
  once: boolean;
  priority: number;
  seq: number;
  active: boolean;
}

function matches(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

type EmitArgs<T> = T extends void | undefined ? [payload?: T] : [payload: T];

export class EventBus<E extends EventMap> {
  private listeners = new Map<string, Set<Entry>>();
  private seq = 0;

  /* ---------------------------- subscribe ---------------------------- */

  /** Subscribe to one event. Returns an unsubscribe function. */
  on<K extends Key<E>>(type: K, fn: Listener<E[K], K>, options?: ListenerOptions): Unsubscribe;
  /** Subscribe with a wildcard pattern such as "cart:*" or "*". */
  on<P extends Pattern<E>>(
    pattern: P,
    fn: Listener<E[Matching<E, P>], Matching<E, P>>,
    options?: ListenerOptions,
  ): Unsubscribe;
  on(pattern: string, fn: Listener<any, any>, options: ListenerOptions = {}): Unsubscribe {
    const { once = false, signal, priority = 0 } = options;
    if (signal?.aborted) return () => {};

    const entry: Entry = {
      pattern,
      fn,
      once,
      priority,
      seq: this.seq++,
      active: true,
    };

    let set = this.listeners.get(pattern);
    if (!set) this.listeners.set(pattern, (set = new Set()));
    set.add(entry);

    const unsubscribe = () => this.remove(entry);
    signal?.addEventListener("abort", unsubscribe, { once: true });
    return unsubscribe;
  }

  /** Subscribe for a single emission (exact event or wildcard). */
  once<K extends Key<E>>(
    type: K,
    fn: Listener<E[K], K>,
    options?: Omit<ListenerOptions, "once">,
  ): Unsubscribe;
  once<P extends Pattern<E>>(
    pattern: P,
    fn: Listener<E[Matching<E, P>], Matching<E, P>>,
    options?: Omit<ListenerOptions, "once">,
  ): Unsubscribe;
  once(
    pattern: string,
    fn: Listener<any, any>,
    options: Omit<ListenerOptions, "once"> = {},
  ): Unsubscribe {
    return (this.on as any)(pattern, fn, { ...options, once: true });
  }

  /** Remove a listener, or every listener registered under a type/pattern. */
  off(pattern: Key<E> | Pattern<E>, fn?: Listener<any, any>): void {
    const set = this.listeners.get(pattern);
    if (!set) return;
    for (const entry of set) {
      if (!fn || entry.fn === fn) this.remove(entry);
    }
  }

  /* ------------------------------- emit ------------------------------ */

  /** Emit synchronously. Returns the number of listeners called. */
  emit<K extends Key<E>>(type: K, ...args: EmitArgs<E[K]>): number {
    const payload = args[0];
    let called = 0;

    for (const entry of this.collect(type)) {
      if (!entry.active) continue; // unsubscribed by an earlier listener
      if (entry.once) this.remove(entry);
      try {
        entry.fn(payload, type);
      } catch (err) {
        // Isolate errors: surface them without stopping other listeners.
        queueMicrotask(() => {
          throw err;
        });
      }
      called++;
    }
    return called;
  }

  /**
   * Emit and await every listener with Promise.all.
   * Listeners are started in priority order and run concurrently.
   * Rejects if any listener throws or rejects (the others still run).
   */
  async emitAsync<K extends Key<E>>(type: K, ...args: EmitArgs<E[K]>): Promise<void> {
    const payload = args[0];
    const runs: Promise<unknown>[] = [];

    for (const entry of this.collect(type)) {
      if (!entry.active) continue;
      if (entry.once) this.remove(entry);
      // The Promise constructor starts the call immediately and
      // converts a synchronous throw into a rejection.
      runs.push(new Promise((resolve) => resolve(entry.fn(payload, type))));
    }
    await Promise.all(runs);
  }

  /**
   * Emit and await listeners one at a time, strictly in priority order.
   * Use when later listeners depend on earlier ones finishing.
   * Stops and rejects on the first error.
   */
  async emitSerial<K extends Key<E>>(type: K, ...args: EmitArgs<E[K]>): Promise<void> {
    const payload = args[0];
    for (const entry of this.collect(type)) {
      if (!entry.active) continue;
      if (entry.once) this.remove(entry);
      await entry.fn(payload, type);
    }
  }

  /* ------------------------------ helpers ---------------------------- */

  /** Resolve with the payload the next time the exact event fires. */
  waitFor<K extends Key<E>>(type: K, signal?: AbortSignal): Promise<E[K]> {
    return new Promise((resolve, reject) => {
      const abortError = () => new DOMException("Aborted", "AbortError");
      if (signal?.aborted) return reject(abortError());
      const off = this.on(type, (payload) => resolve(payload as E[K]), {
        once: true,
      });
      signal?.addEventListener(
        "abort",
        () => {
          off();
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  /** How many listeners (exact + wildcard) would run for this event. */
  listenerCount<K extends Key<E>>(type: K): number {
    return this.collect(type).length;
  }

  /** Remove everything, or only listeners registered under one type/pattern. */
  clear(pattern?: Key<E> | Pattern<E>): void {
    if (pattern === undefined) {
      for (const set of this.listeners.values()) for (const e of set) e.active = false;
      this.listeners.clear();
    } else {
      this.off(pattern);
    }
  }

  /* ----------------------------- internals --------------------------- */

  /** All listeners matching a concrete event, sorted by priority then order. */
  private collect(type: string): Entry[] {
    const out: Entry[] = [];
    for (const [pattern, set] of this.listeners) {
      if (matches(pattern, type)) out.push(...set);
    }
    return out.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  private remove(entry: Entry): void {
    entry.active = false;
    const set = this.listeners.get(entry.pattern);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) this.listeners.delete(entry.pattern);
  }
}

/* ------------------------------------------------------------------ */
/* DOM bridge                                                          */
/* ------------------------------------------------------------------ */

/** Forward DOM CustomEvents from an EventTarget into a typed bus. */
export function bridgeToDOM<E extends EventMap>(
  bus: EventBus<E>,
  target: EventTarget,
  types: Key<E>[],
): Unsubscribe {
  const offs = types.map((type) => {
    const handler = (e: Event) => (bus.emit as any)(type, (e as CustomEvent).detail);
    target.addEventListener(type, handler);
    return () => target.removeEventListener(type, handler);
  });
  return () => offs.forEach((off) => off());
}

/** Dispatch a CustomEvent on any EventTarget. */
export function dispatchOnDOM<T>(
  target: EventTarget,
  type: string,
  detail: T,
  init: Omit<CustomEventInit<T>, "detail"> = {},
): boolean {
  return target.dispatchEvent(new CustomEvent<T>(type, { ...init, detail }));
}

/* ------------------------------------------------------------------ */
/* Example usage                                                       */
/* ------------------------------------------------------------------ */

/* interface AppEvents {
  "user:login": { id: string; name: string };
  "user:logout": void;
  "cart:add": { sku: string; qty: number };
  "cart:remove": { sku: string };
  "cart:checkout": { total: number };
}

export const appBus = new EventBus<AppEvents>();

// Wildcards: namespace and global. `type` tells you which event fired.
appBus.on("cart:*", (payload, type) => {
  console.log(`[cart] ${type}`, payload); // payload is the union of cart payloads
});
appBus.on("*", (_payload, type) => console.log("[audit]", type), {
  priority: -100, // runs last
});

// Priorities: higher first
appBus.on("cart:checkout", () => console.log("validate"), { priority: 10 });
appBus.on("cart:checkout", () => console.log("charge"), { priority: 0 });
appBus.on("cart:checkout", () => console.log("send receipt"), { priority: -10 });

// Sync emit
appBus.emit("cart:add", { sku: "A1", qty: 2 });
appBus.emit("user:logout"); // void events need no payload

// Async emit: all listeners run concurrently, awaited with Promise.all
appBus.on("cart:checkout", async ({ total }) => {
  await fetch("/api/orders", { method: "POST", body: JSON.stringify({ total }) });
});
await appBus.emitAsync("cart:checkout", { total: 42 });

// Serial emit: strict priority order, each awaited before the next
await appBus.emitSerial("cart:checkout", { total: 42 });

// Cleanup with one AbortController
const controller = new AbortController();
appBus.on("cart:*", () => {}, { signal: controller.signal });
appBus.on("user:login", () => {}, { signal: controller.signal });
controller.abort(); // removes both
*/
