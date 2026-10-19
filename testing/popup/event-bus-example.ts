/**
 * Examples for event-bus.ts, one section per feature.
 * Place it next to event-bus.ts and call `runAll()` (e.g. from your entry
 * file) with the browser console open.
 */
import { EventBus, bridgeToDOM, dispatchOnDOM } from "./event-bus.js";

/* ------------------------------------------------------------------ */
/* 0. Define your events                                               */
/* ------------------------------------------------------------------ */
// Works with `interface` or `type`. Use `void` for events with no payload.
interface AppEvents {
  "user:login": { id: string; name: string };
  "user:logout": void;
  "cart:add": { sku: string; qty: number };
  "cart:remove": { sku: string };
  "cart:checkout": { total: number };
  "app:ready": void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const section = (title: string) => console.log(`\n=== ${title} ===`);

/* ------------------------------------------------------------------ */
/* 1. Basic on / emit / unsubscribe                                    */
/* ------------------------------------------------------------------ */
function basics() {
  section("1. Basics");
  const bus = new EventBus<AppEvents>();

  // `on` returns an unsubscribe function.
  const off = bus.on("user:login", ({ id, name }, type) => {
    console.log(`${type}: ${name} (${id})`);
  });

  // emit returns how many listeners were called.
  const called = bus.emit("user:login", { id: "u1", name: "Asha" });
  console.log("listeners called:", called); // 1

  off();
  console.log("after off:", bus.emit("user:login", { id: "u2", name: "Ravi" })); // 0

  // Void events take no payload.
  bus.on("user:logout", () => console.log("logged out"));
  bus.emit("user:logout");

  // These are compile-time errors (uncomment to see):
  // bus.emit("user:login", { id: 1, name: "x" }); // id must be a string
  // bus.emit("cart:nope", {});                    // unknown event
  // bus.emit("cart:add");                         // payload required
}

/* ------------------------------------------------------------------ */
/* 2. once                                                             */
/* ------------------------------------------------------------------ */
function onceExample() {
  section("2. once");
  const bus = new EventBus<AppEvents>();

  bus.once("app:ready", () => console.log("ready handler ran"));
  bus.emit("app:ready"); // runs
  bus.emit("app:ready"); // nothing

  // Same thing via options.
  bus.on("cart:add", (p) => console.log("first add only:", p.sku), { once: true });
  bus.emit("cart:add", { sku: "A1", qty: 1 });
  bus.emit("cart:add", { sku: "A2", qty: 1 }); // ignored by that listener
}

/* ------------------------------------------------------------------ */
/* 3. off: remove one listener or everything for an event              */
/* ------------------------------------------------------------------ */
function offExample() {
  section("3. off");
  const bus = new EventBus<AppEvents>();

  const a = () => console.log("A");
  const b = () => console.log("B");
  bus.on("cart:remove", a);
  bus.on("cart:remove", b);

  bus.off("cart:remove", a); // remove only A
  bus.emit("cart:remove", { sku: "A1" }); // B

  bus.off("cart:remove"); // remove every listener for the event
  console.log("count:", bus.listenerCount("cart:remove")); // 0
}

/* ------------------------------------------------------------------ */
/* 4. Wildcards                                                        */
/* ------------------------------------------------------------------ */
function wildcards() {
  section("4. Wildcards");
  const bus = new EventBus<AppEvents>();

  // Namespace wildcard: payload is the union of all cart:* payloads,
  // and `type` tells you which event fired.
  bus.on("cart:*", (payload, type) => {
    console.log(`[cart:*] ${type}`, payload);
    if (type === "cart:add") {
      // `payload` is still the union here; narrow it yourself if needed.
      console.log("  sku added:", (payload as AppEvents["cart:add"]).sku);
    }
  });

  // Global wildcard: sees everything (good for logging / analytics).
  bus.on("*", (_payload, type) => console.log(`[*] ${type}`));

  bus.emit("cart:add", { sku: "A1", qty: 2 }); // both listeners
  bus.emit("user:logout"); // only the "*" listener

  // How many listeners would run for an event (exact + wildcard)?
  console.log("cart:add listeners:", bus.listenerCount("cart:add")); // 2
  console.log("user:logout listeners:", bus.listenerCount("user:logout")); // 1

  // Remove everything registered under one pattern.
  bus.off("cart:*");
  console.log("after off('cart:*'):", bus.listenerCount("cart:add")); // 1
}

/* ------------------------------------------------------------------ */
/* 5. Priorities                                                       */
/* ------------------------------------------------------------------ */
function priorities() {
  section("5. Priorities");
  const bus = new EventBus<AppEvents>();

  // Higher runs first; equal priority runs in subscribe order.
  bus.on("cart:checkout", () => console.log("3. send receipt"), { priority: -10 });
  bus.on("cart:checkout", () => console.log("1. validate"), { priority: 10 });
  bus.on("cart:checkout", () => console.log("2. charge (default 0)"));
  bus.on("cart:checkout", () => console.log("2b. charge, subscribed later"));

  // Priorities apply across exact AND wildcard listeners.
  bus.on("*", (_p, type) => console.log(`4. audit log: ${type}`), { priority: -100 });
  bus.on("cart:*", () => console.log("0. runs before validate"), { priority: 50 });

  bus.emit("cart:checkout", { total: 99 });
}

/* ------------------------------------------------------------------ */
/* 6. emitAsync (Promise.all)                                          */
/* ------------------------------------------------------------------ */
async function asyncEmit() {
  section("6. emitAsync (concurrent)");
  const bus = new EventBus<AppEvents>();
  const t0 = performance.now();
  const at = () => `${Math.round(performance.now() - t0)}ms`;

  bus.on("cart:checkout", async () => {
    console.log("save order started", at());
    await sleep(300);
    console.log("save order done", at());
  });
  bus.on("cart:checkout", async () => {
    console.log("send email started", at());
    await sleep(200);
    console.log("send email done", at());
  });

  // Both start immediately and finish in ~300ms total, not 500ms.
  await bus.emitAsync("cart:checkout", { total: 10 });
  console.log("all listeners finished", at());

  // If any listener throws/rejects, emitAsync rejects (the rest still run).
  bus.clear();
  bus.on("cart:checkout", async () => {
    await sleep(50);
    throw new Error("payment failed");
  });
  bus.on("cart:checkout", async () => {
    await sleep(100);
    console.log("this one still completes");
  });
  try {
    await bus.emitAsync("cart:checkout", { total: 10 });
  } catch (err) {
    console.log("emitAsync rejected:", (err as Error).message);
  }
  await sleep(150); // let the second listener finish for the demo
}

/* ------------------------------------------------------------------ */
/* 7. emitSerial (one at a time, in priority order)                    */
/* ------------------------------------------------------------------ */
async function serialEmit() {
  section("7. emitSerial (sequential)");
  const bus = new EventBus<AppEvents>();
  const order: string[] = [];

  bus.on(
    "cart:checkout",
    async () => {
      await sleep(100);
      order.push("validate");
    },
    { priority: 10 },
  );
  bus.on("cart:checkout", async () => {
    await sleep(10);
    order.push("charge"); // only runs after validate has finished
  });

  await bus.emitSerial("cart:checkout", { total: 10 });
  console.log("order:", order.join(" -> ")); // validate -> charge

  // A thrown error stops the chain.
  bus.clear();
  bus.on(
    "cart:checkout",
    () => {
      throw new Error("stop here");
    },
    { priority: 1 },
  );
  bus.on("cart:checkout", () => console.log("never runs"));
  try {
    await bus.emitSerial("cart:checkout", { total: 10 });
  } catch (err) {
    console.log("emitSerial rejected:", (err as Error).message);
  }
}

/* ------------------------------------------------------------------ */
/* 8. Error isolation in sync emit                                     */
/* ------------------------------------------------------------------ */
async function errorIsolation() {
  section("8. Error isolation");
  const bus = new EventBus<AppEvents>();

  // A throwing listener is re-thrown in a microtask, so it shows up as a
  // normal uncaught error (window.onerror) without blocking other listeners.
  const onError = (e: ErrorEvent) => {
    console.log("reported to window.onerror:", e.message);
    e.preventDefault(); // keep the console clean for the demo
  };
  window.addEventListener("error", onError);

  bus.on("app:ready", () => {
    throw new Error("listener 1 blew up");
  });
  bus.on("app:ready", () => console.log("listener 2 still runs"));

  const n = bus.emit("app:ready");
  console.log("listeners called:", n); // 2

  await sleep(0); // allow the microtask to fire
  window.removeEventListener("error", onError);
}

/* ------------------------------------------------------------------ */
/* 9. Unsubscribing during an emit                                     */
/* ------------------------------------------------------------------ */
function mutateDuringEmit() {
  section("9. Unsubscribe during emit");
  const bus = new EventBus<AppEvents>();

  let offB = () => {};
  bus.on(
    "app:ready",
    () => {
      console.log("A runs and removes B");
      offB();
    },
    { priority: 10 },
  );
  offB = bus.on("app:ready", () => console.log("B (skipped, was removed)"));

  bus.emit("app:ready");
}

/* ------------------------------------------------------------------ */
/* 10. waitFor (promise-style)                                         */
/* ------------------------------------------------------------------ */
async function waitForExample() {
  section("10. waitFor");
  const bus = new EventBus<AppEvents>();

  setTimeout(() => bus.emit("user:login", { id: "u1", name: "Asha" }), 100);
  const user = await bus.waitFor("user:login");
  console.log("logged in:", user.name);

  // With a timeout/cancel via AbortSignal (rejects with AbortError).
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  try {
    await bus.waitFor("cart:checkout", controller.signal);
  } catch (err) {
    console.log("waitFor aborted:", (err as DOMException).name); // AbortError
  }
  console.log("leftover listeners:", bus.listenerCount("cart:checkout")); // 0
}

/* ------------------------------------------------------------------ */
/* 11. AbortSignal cleanup (component lifecycle)                       */
/* ------------------------------------------------------------------ */
class CartBadge {
  private controller = new AbortController();
  count = 0;

  constructor(private bus: EventBus<AppEvents>) {
    const { signal } = this.controller;
    // Every subscription shares one signal.
    bus.on("cart:add", ({ qty }) => (this.count += qty), { signal });
    bus.on("cart:remove", () => (this.count = Math.max(0, this.count - 1)), { signal });
    bus.once("user:logout", () => (this.count = 0), { signal });
  }

  destroy() {
    this.controller.abort(); // removes all three listeners at once
  }
}

function abortSignalCleanup() {
  section("11. AbortSignal cleanup");
  const bus = new EventBus<AppEvents>();
  const badge = new CartBadge(bus);

  bus.emit("cart:add", { sku: "A1", qty: 3 });
  console.log("badge count:", badge.count); // 3
  console.log("listeners before destroy:", bus.listenerCount("cart:add")); // 1

  badge.destroy();
  bus.emit("cart:add", { sku: "A1", qty: 5 });
  console.log("badge count after destroy:", badge.count); // still 3
  console.log("listeners after destroy:", bus.listenerCount("cart:add")); // 0

  // An already-aborted signal never subscribes.
  const dead = new AbortController();
  dead.abort();
  bus.on("cart:add", () => {}, { signal: dead.signal });
  console.log("with aborted signal:", bus.listenerCount("cart:add")); // 0
}

/* ------------------------------------------------------------------ */
/* 12. clear                                                           */
/* ------------------------------------------------------------------ */
function clearExample() {
  section("12. clear");
  const bus = new EventBus<AppEvents>();
  bus.on("cart:add", () => {});
  bus.on("user:login", () => {});
  bus.on("cart:*", () => {});

  bus.clear("cart:*"); // only the "cart:*" pattern
  console.log("cart:add:", bus.listenerCount("cart:add")); // 1
  bus.clear(); // everything
  console.log("user:login:", bus.listenerCount("user:login")); // 0
}

/* ------------------------------------------------------------------ */
/* 13. DOM bridge                                                      */
/* ------------------------------------------------------------------ */
function domBridge() {
  section("13. DOM bridge");
  const bus = new EventBus<AppEvents>();
  bus.on("user:login", (u) => console.log("bus got login from DOM:", u.name));

  // DOM CustomEvents -> bus. Returns a function that detaches the bridge.
  const detach = bridgeToDOM(bus, document, ["user:login", "cart:add"]);

  // Anything (another script, a web component) can dispatch a CustomEvent.
  dispatchOnDOM(document, "user:login", { id: "u9", name: "Meera" });

  // Bus -> DOM: let plain addEventListener code observe bus events.
  const onCartAdd = (e: Event) => console.log("DOM listener saw:", (e as CustomEvent).detail);
  document.addEventListener("cart:add", onCartAdd);
  bus.on("cart:add", (payload) => dispatchOnDOM(document, "cart:add-dom", payload));
  // (Use a different DOM name than the bridged one to avoid an echo loop.)
  document.addEventListener("cart:add-dom", onCartAdd);
  bus.emit("cart:add", { sku: "A1", qty: 1 });

  detach();
  document.removeEventListener("cart:add", onCartAdd);
  document.removeEventListener("cart:add-dom", onCartAdd);
}

/* ------------------------------------------------------------------ */
/* 14. Separate buses / typed module-level singleton                   */
/* ------------------------------------------------------------------ */
// Create one bus per domain so event maps stay small and focused.
interface UIEvents {
  "modal:open": { id: string };
  "modal:close": { id: string };
}
export const appBus = new EventBus<AppEvents>();
export const uiBus = new EventBus<UIEvents>();

function multipleBuses() {
  section("14. Multiple buses");
  uiBus.on("modal:*", (p, type) => console.log(type, p.id));
  uiBus.emit("modal:open", { id: "settings" });
  appBus.emit("app:ready"); // independent: no cross-talk
  uiBus.clear();
}

/* ------------------------------------------------------------------ */
export async function runAll() {
  basics();
  onceExample();
  offExample();
  wildcards();
  priorities();
  await asyncEmit();
  await serialEmit();
  await errorIsolation();
  mutateDuringEmit();
  await waitForExample();
  abortSignalCleanup();
  clearExample();
  domBridge();
  multipleBuses();
  console.log("\nAll examples finished.");
}

// Uncomment to run on load:
runAll();
