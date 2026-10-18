import { BannerOpts, Page } from "@common/types";

/**
 * runs inside the page
 */
export function collectPage(): Page {
  const dt = document.doctype;
  const doctype = dt
    ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ""}${!dt.publicId && dt.systemId ? " SYSTEM" : ""}${dt.systemId ? ` "${dt.systemId}"` : ""}>\n`
    : "";

  const meta: Record<string, string | null> = {};
  document.querySelectorAll("meta[name],meta[property],meta[http-equiv]").forEach((metaElement) => {
    const attributeValue =
      metaElement.getAttribute("name") ||
      metaElement.getAttribute("property") ||
      metaElement.getAttribute("http-equiv");
    if (attributeValue && !(attributeValue in meta))
      meta[attributeValue] = metaElement.getAttribute("content");
  });

  return {
    html: doctype + document.documentElement.outerHTML,
    url: location.href,
    title: document.title,
    referrer: document.referrer,
    lang: document.documentElement.lang || null,
    charset: document.characterSet,
    contentType: document.contentType,
    lastModified: document.lastModified,
    canonical: document.querySelector<HTMLLinkElement>('link[rel~="canonical"]')?.href || null,
    favicon: document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href || null,
    meta,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    userAgent: navigator.userAgent,
    language: navigator.language,
  };
}

/* ================= in-page banner (prompt / toast) ================= */
export function pageBanner(opts: BannerOpts) {
  // self-contained: serialized into the page
  const api = globalThis.browser ?? globalThis.chrome;
  const ID = "__url_archiver_banner__";
  document.getElementById(ID)?.remove();
  const host = document.createElement("div");
  host.id = ID;
  host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;";

  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent =
    ".b{font:14px/1.4 system-ui,sans-serif;color:#fff;background:#1f2937;border-radius:10px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:340px;display:flex;flex-direction:column;gap:10px;word-break:break-word}.b.ok{background:#15803d}.b.err{background:#b91c1c}.r{display:flex;gap:8px;justify-content:flex-end}button{font:inherit;border:0;border-radius:6px;padding:5px 12px;cursor:pointer;background:#fff;color:#111}button.p{background:#3b82f6;color:#fff}";
  const box = document.createElement("div");
  root.append(style, box);

  let timer: NodeJS.Timeout;

  const close = () => {
    clearTimeout(timer);
    host.remove();
  };

  function render(kind: string, text: string, buttons: any) {
    box.className = "b " + (kind || "");
    box.replaceChildren();
    const t = document.createElement("div");
    t.textContent = text;
    box.append(t);
    if (buttons && buttons.length) {
      const row = document.createElement("div");
      row.className = "r";
      for (const [label, fn, primary] of buttons) {
        const b = document.createElement("button");
        b.textContent = label;
        if (primary) b.className = "p";
        b.onclick = fn;
        row.append(b);
      }
      box.append(row);
    }
  }
  const archive = () => {
    render("", "Archiving…", []);
    api.runtime
      .sendMessage({ type: "archiveFromPage" })
      .then((r) => {
        if (r && r.ok) {
          const n = r.status && r.status.count;
          render("ok", "Archived ✓" + (n ? ` (${n} version${n === 1 ? "" : "s"})` : ""), [
            ["Close", close],
          ]);
          timer = setTimeout(close, 5000);
        } else
          render("err", "Archive failed: " + ((r && r.error) || "unknown error"), [
            ["Close", close],
          ]);
      })
      .catch((e) => render("err", "Archive failed: " + e.message, [["Close", close]]));
  };
  if (opts.mode === "prompt")
    render("", opts.text || "Archive this page?", [
      ["Dismiss", close],
      ["Archive now", archive, true],
    ]);
  else {
    render(opts.kind, opts.text, [["Close", close]]);
    if (opts.kind === "ok") timer = setTimeout(close, 5000);
  }
  document.documentElement.append(host);
}
