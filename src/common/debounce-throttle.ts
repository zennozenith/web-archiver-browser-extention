/* eslint-disable @typescript-eslint/no-explicit-any */

export type AnyFn = (...args: any[]) => any;

export interface DebounceOptions {
  /** Invoke on the leading edge of the wait period. Default: false */
  leading?: boolean;
  /** Invoke on the trailing edge of the wait period. Default: true */
  trailing?: boolean;
  /** Maximum time (ms) the function may be delayed before it is forced to run. */
  maxWait?: number;
}

export interface ThrottleOptions {
  /** Invoke on the leading edge. Default: true */
  leading?: boolean;
  /** Invoke on the trailing edge. Default: true */
  trailing?: boolean;
}

export interface Debounced<F extends AnyFn> {
  (this: ThisParameterType<F>, ...args: Parameters<F>): ReturnType<F> | undefined;
  /** Drop any pending invocation and reset all internal state. */
  cancel(): void;
  /** Immediately run a pending trailing invocation (if any) and return the last result. */
  flush(): ReturnType<F> | undefined;
  /** True if an invocation is currently scheduled. */
  pending(): boolean;
}

export type Throttled<F extends AnyFn> = Debounced<F>;

/**
 * Creates a debounced function that delays invoking `func` until `wait` ms
 * have elapsed since the last time it was called.
 *
 * - Preserves `this` and argument types.
 * - Supports leading / trailing edges and `maxWait`.
 * - Returns the result of the most recent invocation (or undefined before the first).
 * - Exposes `cancel()`, `flush()` and `pending()`.
 * - Uses Date.now() comparisons, so it tolerates timers firing early/late
 *   and system clock going backwards.
 */
export function debounce<F extends AnyFn>(
  func: F,
  wait = 0,
  options: DebounceOptions = {},
): Debounced<F> {
  if (typeof func !== "function") {
    throw new TypeError("debounce: expected a function");
  }

  wait = Math.max(0, Number(wait) || 0);

  const leading = !!options.leading;
  const trailing = options.trailing === undefined ? true : !!options.trailing;
  const maxing = options.maxWait !== undefined;
  const maxWait = maxing ? Math.max(Number(options.maxWait) || 0, wait) : 0;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: Parameters<F> | undefined;
  let lastThis: ThisParameterType<F> | undefined;
  let lastCallTime: number | undefined;
  let lastInvokeTime = 0;
  let result: ReturnType<F> | undefined;

  function invoke(time: number): ReturnType<F> | undefined {
    const args = lastArgs as Parameters<F>;
    const thisArg = lastThis;
    lastArgs = lastThis = undefined;
    lastInvokeTime = time;
    result = func.apply(thisArg, args);
    return result;
  }

  function remainingWait(time: number): number {
    const sinceLastCall = time - (lastCallTime as number);
    const sinceLastInvoke = time - lastInvokeTime;
    const timeWaiting = wait - sinceLastCall;
    return maxing ? Math.min(timeWaiting, maxWait - sinceLastInvoke) : timeWaiting;
  }

  function shouldInvoke(time: number): boolean {
    if (lastCallTime === undefined) return true;
    const sinceLastCall = time - lastCallTime;
    const sinceLastInvoke = time - lastInvokeTime;
    return (
      sinceLastCall >= wait ||
      sinceLastCall < 0 || // system clock moved backwards
      (maxing && sinceLastInvoke >= maxWait)
    );
  }

  function startTimer(ms: number): void {
    timerId = setTimeout(timerExpired, ms);
  }

  function leadingEdge(time: number): ReturnType<F> | undefined {
    lastInvokeTime = time;
    startTimer(wait);
    return leading ? invoke(time) : result;
  }

  function trailingEdge(time: number): ReturnType<F> | undefined {
    timerId = undefined;
    // Only invoke if there was at least one call since the last invocation.
    if (trailing && lastArgs) return invoke(time);
    lastArgs = lastThis = undefined;
    return result;
  }

  function timerExpired(): void {
    const time = Date.now();
    if (shouldInvoke(time)) {
      trailingEdge(time);
      return;
    }
    startTimer(remainingWait(time));
  }

  function cancel(): void {
    if (timerId !== undefined) clearTimeout(timerId);
    timerId = undefined;
    lastArgs = lastThis = lastCallTime = undefined;
    lastInvokeTime = 0;
  }

  function flush(): ReturnType<F> | undefined {
    return timerId === undefined ? result : trailingEdge(Date.now());
  }

  function pending(): boolean {
    return timerId !== undefined;
  }

  const debounced = function (
    this: ThisParameterType<F>,
    ...args: Parameters<F>
  ): ReturnType<F> | undefined {
    const time = Date.now();
    const isInvoking = shouldInvoke(time);

    lastArgs = args;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastThis = this;
    lastCallTime = time;

    if (isInvoking) {
      if (timerId === undefined) return leadingEdge(time);
      if (maxing) {
        // Burst of calls: restart the timer and invoke right now (maxWait hit).
        clearTimeout(timerId);
        startTimer(wait);
        return invoke(time);
      }
    }
    if (timerId === undefined) startTimer(wait);
    return result;
  } as Debounced<F>;

  debounced.cancel = cancel;
  debounced.flush = flush;
  debounced.pending = pending;
  return debounced;
}

/**
 * Creates a throttled function that invokes `func` at most once per `wait` ms.
 * By default it runs on both the leading and trailing edges, so the first call
 * fires immediately and the last call within a window is not lost.
 */
export function throttle<F extends AnyFn>(
  func: F,
  wait = 0,
  options: ThrottleOptions = {},
): Throttled<F> {
  if (typeof func !== "function") {
    throw new TypeError("throttle: expected a function");
  }
  return debounce(func, wait, {
    leading: options.leading === undefined ? true : !!options.leading,
    trailing: options.trailing === undefined ? true : !!options.trailing,
    maxWait: wait,
  });
}

/* ------------------------------- Usage ---------------------------------

const onSearch = debounce((q: string) => fetchResults(q), 300);
input.addEventListener("input", (e) => onSearch((e.target as HTMLInputElement).value));

// Fire immediately, then ignore calls until 500ms of quiet:
const save = debounce(saveDraft, 500, { leading: true, trailing: false });

// Guarantee a save at least every 5s during continuous typing:
const autosave = debounce(saveDraft, 1000, { maxWait: 5000 });

// At most once per 100ms while scrolling:
const onScroll = throttle(updatePosition, 100);
window.addEventListener("scroll", onScroll, { passive: true });

// Cleanup (e.g. React useEffect return, component unmount):
onScroll.cancel();

// Before navigating away, run any pending call:
window.addEventListener("beforeunload", () => autosave.flush());

------------------------------------------------------------------------- */
