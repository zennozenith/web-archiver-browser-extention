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
function matches(pattern, type) {
    if (pattern === "*")
        return true;
    if (pattern.endsWith("*"))
        return type.startsWith(pattern.slice(0, -1));
    return pattern === type;
}
export class EventBus {
    listeners = new Map();
    seq = 0;
    on(pattern, fn, options = {}) {
        const { once = false, signal, priority = 0 } = options;
        if (signal?.aborted)
            return () => { };
        const entry = {
            pattern,
            fn,
            once,
            priority,
            seq: this.seq++,
            active: true,
        };
        let set = this.listeners.get(pattern);
        if (!set)
            this.listeners.set(pattern, (set = new Set()));
        set.add(entry);
        const unsubscribe = () => this.remove(entry);
        signal?.addEventListener("abort", unsubscribe, { once: true });
        return unsubscribe;
    }
    once(pattern, fn, options = {}) {
        return this.on(pattern, fn, { ...options, once: true });
    }
    /** Remove a listener, or every listener registered under a type/pattern. */
    off(pattern, fn) {
        const set = this.listeners.get(pattern);
        if (!set)
            return;
        for (const entry of [...set]) {
            if (!fn || entry.fn === fn)
                this.remove(entry);
        }
    }
    /* ------------------------------- emit ------------------------------ */
    /** Emit synchronously. Returns the number of listeners called. */
    emit(type, ...args) {
        const payload = args[0];
        let called = 0;
        for (const entry of this.collect(type)) {
            if (!entry.active)
                continue; // unsubscribed by an earlier listener
            if (entry.once)
                this.remove(entry);
            try {
                entry.fn(payload, type);
            }
            catch (err) {
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
    async emitAsync(type, ...args) {
        const payload = args[0];
        const runs = [];
        for (const entry of this.collect(type)) {
            if (!entry.active)
                continue;
            if (entry.once)
                this.remove(entry);
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
    async emitSerial(type, ...args) {
        const payload = args[0];
        for (const entry of this.collect(type)) {
            if (!entry.active)
                continue;
            if (entry.once)
                this.remove(entry);
            await entry.fn(payload, type);
        }
    }
    /* ------------------------------ helpers ---------------------------- */
    /** Resolve with the payload the next time the exact event fires. */
    waitFor(type, signal) {
        return new Promise((resolve, reject) => {
            const abortError = () => new DOMException("Aborted", "AbortError");
            if (signal?.aborted)
                return reject(abortError());
            const off = this.on(type, (payload) => resolve(payload), {
                once: true,
            });
            signal?.addEventListener("abort", () => {
                off();
                reject(abortError());
            }, { once: true });
        });
    }
    /** How many listeners (exact + wildcard) would run for this event. */
    listenerCount(type) {
        return this.collect(type).length;
    }
    /** Remove everything, or only listeners registered under one type/pattern. */
    clear(pattern) {
        if (pattern === undefined) {
            for (const set of this.listeners.values())
                for (const e of set)
                    e.active = false;
            this.listeners.clear();
        }
        else {
            this.off(pattern);
        }
    }
    /* ----------------------------- internals --------------------------- */
    /** All listeners matching a concrete event, sorted by priority then order. */
    collect(type) {
        const out = [];
        for (const [pattern, set] of this.listeners) {
            if (matches(pattern, type))
                out.push(...set);
        }
        return out.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    }
    remove(entry) {
        entry.active = false;
        const set = this.listeners.get(entry.pattern);
        if (!set)
            return;
        set.delete(entry);
        if (set.size === 0)
            this.listeners.delete(entry.pattern);
    }
}
/* ------------------------------------------------------------------ */
/* DOM bridge                                                          */
/* ------------------------------------------------------------------ */
/** Forward DOM CustomEvents from an EventTarget into a typed bus. */
export function bridgeToDOM(bus, target, types) {
    const offs = types.map((type) => {
        const handler = (e) => bus.emit(type, e.detail);
        target.addEventListener(type, handler);
        return () => target.removeEventListener(type, handler);
    });
    return () => offs.forEach((off) => off());
}
/** Dispatch a CustomEvent on any EventTarget. */
export function dispatchOnDOM(target, type, detail, init = {}) {
    return target.dispatchEvent(new CustomEvent(type, { ...init, detail }));
}
/* ------------------------------------------------------------------
   Example usage
   ------------------------------------------------------------------

interface AppEvents {
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

------------------------------------------------------------------------- */
