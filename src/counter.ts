import Alpine from "alpinejs";

interface CounterState {
  count: number;
  increment(): void;
  reset(): void;
}

function counter(): CounterState {
  return {
    count: 0,
    increment() {
      this.count++;
    },
    reset() {
      this.count = 0;
    },
  };
}

Alpine.data("counter", counter);

declare global {
  interface Window {
    Alpine: typeof Alpine;
  }
}
window.Alpine = Alpine;
Alpine.start();
