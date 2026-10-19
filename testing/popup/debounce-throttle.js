/* eslint-disable @typescript-eslint/no-explicit-any */
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
export function debounce(func, wait = 0, options = {}) {
    if (typeof func !== "function") {
        throw new TypeError("debounce: expected a function");
    }
    wait = Math.max(0, Number(wait) || 0);
    const leading = !!options.leading;
    const trailing = options.trailing === undefined ? true : !!options.trailing;
    const maxing = options.maxWait !== undefined;
    const maxWait = maxing ? Math.max(Number(options.maxWait) || 0, wait) : 0;
    let timerId;
    let lastArgs;
    let lastThis;
    let lastCallTime;
    let lastInvokeTime = 0;
    let result;
    function invoke(time) {
        const args = lastArgs;
        const thisArg = lastThis;
        lastArgs = lastThis = undefined;
        lastInvokeTime = time;
        result = func.apply(thisArg, args);
        return result;
    }
    function remainingWait(time) {
        const sinceLastCall = time - lastCallTime;
        const sinceLastInvoke = time - lastInvokeTime;
        const timeWaiting = wait - sinceLastCall;
        return maxing ? Math.min(timeWaiting, maxWait - sinceLastInvoke) : timeWaiting;
    }
    function shouldInvoke(time) {
        if (lastCallTime === undefined)
            return true;
        const sinceLastCall = time - lastCallTime;
        const sinceLastInvoke = time - lastInvokeTime;
        return (sinceLastCall >= wait ||
            sinceLastCall < 0 || // system clock moved backwards
            (maxing && sinceLastInvoke >= maxWait));
    }
    function startTimer(ms) {
        timerId = setTimeout(timerExpired, ms);
    }
    function leadingEdge(time) {
        lastInvokeTime = time;
        startTimer(wait);
        return leading ? invoke(time) : result;
    }
    function trailingEdge(time) {
        timerId = undefined;
        // Only invoke if there was at least one call since the last invocation.
        if (trailing && lastArgs)
            return invoke(time);
        lastArgs = lastThis = undefined;
        return result;
    }
    function timerExpired() {
        const time = Date.now();
        if (shouldInvoke(time)) {
            trailingEdge(time);
            return;
        }
        startTimer(remainingWait(time));
    }
    function cancel() {
        if (timerId !== undefined)
            clearTimeout(timerId);
        timerId = undefined;
        lastArgs = lastThis = lastCallTime = undefined;
        lastInvokeTime = 0;
    }
    function flush() {
        return timerId === undefined ? result : trailingEdge(Date.now());
    }
    function pending() {
        return timerId !== undefined;
    }
    const debounced = function (...args) {
        const time = Date.now();
        const isInvoking = shouldInvoke(time);
        lastArgs = args;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        lastThis = this;
        lastCallTime = time;
        if (isInvoking) {
            if (timerId === undefined)
                return leadingEdge(time);
            if (maxing) {
                // Burst of calls: restart the timer and invoke right now (maxWait hit).
                clearTimeout(timerId);
                startTimer(wait);
                return invoke(time);
            }
        }
        if (timerId === undefined)
            startTimer(wait);
        return result;
    };
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
export function throttle(func, wait = 0, options = {}) {
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
