// toaster.ts

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  type?: ToastType;
  duration?: number;
  dismissible?: boolean;
  position?: ToastPosition;
  id?: string;
}

export type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
  dismissible: boolean;
  element: HTMLElement;
  timeoutId?: number;
}

const ICONS: Record<ToastType, string> = {
  success: "✓",
  error: "✕",
  warning: "!",
  info: "i",
};

/**
 * Toaster — a lightweight, dependency-free toast notification manager.
 *
 * Toast markup is sourced from a `<template id="toast-template">` element in the DOM.
 * If not found, a template is created and injected once. All styling lives in CSS
 * (see toaster.css) and uses your `:root` custom properties for light/dark modes.
 */
export class Toaster {
  private static instance: Toaster | null = null;

  private containers = new Map<ToastPosition, HTMLElement>();
  private toasts = new Map<string, Toast>();
  private counter = 0;
  private template: HTMLTemplateElement | null = null;

  private constructor() {
    this.template = this.resolveTemplate();
  }

  public static getInstance(): Toaster {
    if (!Toaster.instance) {
      Toaster.instance = new Toaster();
    }
    return Toaster.instance;
  }

  /**
   * Show a generic toast.
   * @returns The toast id (for later dismissal).
   */
  public show(message: string, options: ToastOptions = {}): string {
    if (typeof document === "undefined") {
      return options.id ?? this.generateId();
    }

    const {
      type = "info",
      duration = 3000,
      dismissible = true,
      position = "top-right",
      id = this.generateId(),
    } = options;

    if (this.toasts.has(id)) {
      this.dismiss(id, /* force */ true); // remove immediately, no animation
    }

    const container = this.getContainer(position);
    const element = this.createToastFromTemplate(id, message, type, dismissible);
    container.appendChild(element);

    const toast: Toast = { id, message, type, duration, dismissible, element };

    if (duration > 0) {
      // Progress bar duration mirrors total duration
      const progress = element.querySelector<HTMLElement>(".toaster-progress");
      if (progress) progress.style.animationDuration = `${duration}ms`;

      toast.timeoutId = window.setTimeout(() => this.dismiss(id), duration);
    } else {
      // No auto-dismiss → no progress bar
      element.querySelector(".toaster-progress")?.remove();
    }

    this.toasts.set(id, toast);
    return id;
  }

  public success(message: string, options: Omit<ToastOptions, "type"> = {}): string {
    return this.show(message, { ...options, type: "success" });
  }

  public error(message: string, options: Omit<ToastOptions, "type"> = {}): string {
    return this.show(message, { ...options, type: "error" });
  }

  public warning(message: string, options: Omit<ToastOptions, "type"> = {}): string {
    return this.show(message, { ...options, type: "warning" });
  }

  public info(message: string, options: Omit<ToastOptions, "type"> = {}): string {
    return this.show(message, { ...options, type: "info" });
  }

  public dismiss(id: string, force = false): void {
    const toast = this.toasts.get(id);
    if (!toast) return;

    if (toast.timeoutId !== undefined) {
      clearTimeout(toast.timeoutId);
    }

    const element = toast.element;
    const parent = element.parentElement as HTMLElement | null;

    const finish = () => {
      element.remove();
      if (this.toasts.get(id) === toast) {
        this.toasts.delete(id);
      }
      this.cleanupEmptyContainer(parent);
    };

    if (force) {
      finish();
      return;
    }

    element.classList.add("toaster-item--closing");
    window.setTimeout(finish, 200);
  }

  public dismissAll(): void {
    Array.from(this.toasts.keys()).forEach((id) => this.dismiss(id));
  }

  // ---------- Private helpers ----------

  private generateId(): string {
    return `toast-${++this.counter}-${Date.now()}`;
  }

  /**
   * Find the `<template id="toast-template">` in the DOM.
   * If it doesn't exist, create and inject a default one.
   */
  private resolveTemplate(): HTMLTemplateElement {
    if (typeof document === "undefined") {
      // SSR safety — never used at runtime
      throw new Error("document undefined");
    }

    const existing = document.getElementById("toast-template");
    if (existing instanceof HTMLTemplateElement) {
      return existing;
    }

    // Fallback: build a default template and inject it
    const template = document.createElement("template");
    template.id = "toast-template";
    template.innerHTML = `
      <div class="toaster-item" role="alert" aria-live="assertive">
        <span class="toaster-icon" aria-hidden="true"></span>
        <span class="toaster-message"></span>
        <button class="toaster-close" type="button" aria-label="Close">×</button>
        <div class="toaster-progress"></div>
      </div>
    `.trim();
    document.body.appendChild(template);
    return template;
  }

  private getContainer(position: ToastPosition): HTMLElement {
    let container = this.containers.get(position);
    if (!container) {
      container = document.createElement("div");
      container.className = "toaster-container";
      container.dataset.position = position;
      document.body.appendChild(container);
      this.containers.set(position, container);
    }
    return container;
  }

  /**
   * Clone the template, fill in content, and wire up dismiss handler.
   */
  private createToastFromTemplate(
    id: string,
    message: string,
    type: ToastType,
    dismissible: boolean,
  ): HTMLElement {
    if (!this.template) this.template = this.resolveTemplate();

    const fragment = this.template.content.cloneNode(true) as DocumentFragment;
    const root = fragment.firstElementChild as HTMLElement | null;
    if (!root) {
      throw new Error("[Toaster] Template has no root element.");
    }

    // Type class + data attributes
    root.classList.add(`toaster-item--${type}`);
    root.dataset.toastId = id;
    root.dataset.type = type;

    // Icon
    const icon = root.querySelector<HTMLElement>(".toaster-icon");
    if (icon) icon.textContent = ICONS[type] ?? "";

    // Message (textContent → XSS-safe)
    const msg = root.querySelector<HTMLElement>(".toaster-message");
    if (msg) msg.textContent = message;

    // Close button
    const closeBtn = root.querySelector<HTMLButtonElement>(".toaster-close");
    if (closeBtn) {
      if (dismissible) {
        closeBtn.addEventListener("click", () => this.dismiss(id));
      } else {
        closeBtn.remove();
      }
    }

    return root;
  }

  private cleanupEmptyContainer(container: HTMLElement | null): void {
    if (!container) return;
    if (container.children.length === 0) {
      container.remove();
      for (const [pos, el] of this.containers.entries()) {
        if (el === container) {
          this.containers.delete(pos);
          break;
        }
      }
    }
  }
}

export const toaster = Toaster.getInstance();
