import { log as rootLog } from "./log.ts";

const log = rootLog.child("dom");

export function q<T extends Element>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Selector not found: ${sel}`);
  return el;
}

export function getElementById<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const el = document.getElementById(id.startsWith("#") ? id.slice(1) : id);
  if (!(el instanceof type)) {
    log.error(`#${id} ${el ? `is not a ${type.name}` : "is missing from the document"}`);
    throw new Error(`#${id} ${el ? `is not a ${type.name}` : "is missing from the document"}`);
  }
  return el;
}

export function setElementText(el: Element, text: string, cls: string = ""): void {
  el.textContent = text;
  el.className = cls || "";
}
