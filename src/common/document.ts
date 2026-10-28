import { log as rootLog } from "./log.ts";

const log = rootLog.child("dom");

export function q<T extends Element>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`${root} missing ${sel}`);
  return el;
}

export function getElementById<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id.startsWith("#") ? id.slice(1, id.length) : id);

  if (element instanceof type) {
    return element;
  } else {
    log.warn(
      `getElementById: #${id} is ${element ? `not a ${type.name}` : "missing from the document"}`,
      element,
    );
  }
  return element as T;
  // return element instanceof type ? element : null;
}

export function setElementText(el: Element, text: string, cls: string = ""): void {
  el.textContent = text;
  el.className = cls || "";
}
