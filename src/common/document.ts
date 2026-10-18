import { log } from ".";

export function getElementById<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id.startsWith("#") ? id.slice(1, id.length) : id);

  if (element instanceof type) {
    return element;
  } else {
    log.warn(`Element with id: ${id}, of type: ${type}, expected type: ${typeof element}`, element);
  }
  return element as T;
  // return element instanceof type ? element : null;
}

export function setElementText(el: Element, text: string, cls: string = ""): void {
  el.textContent = text;
  el.className = cls || "";
}
