import type { Result } from "@common/error";
import { ArchiveStatus } from "../archive";
import { IdLessTag } from "../tags";
import type { Url, Option } from "@common/types";

export interface BannerOpts {
  kind: "ok" | "err" | (string & {});
  text: string;
  mode: "prompt" | "toast" | (string & {});
  /* optional (prompt mode): tag names offered as a chip row before confirming */
  tags?: Vec<IdLessTag>;
}

export interface Page {
  html: string;
  url: string;
  title: string;
  referrer: string;
  lang: Option<string>; //  eg: "en-US"
  charset: string; //      eg: "UTF-8",
  contentType: string; //  eg: "text/html",
  lastModified: string; // eg: "09/04/2026 17:47:04"
  canonical: Option<string>;

  favicon: Option<Url>;
  meta: Record<string, Option<string>>;
  viewport: {
    width: number; //      eg: 1080
    height: number; //     eg: 1902
    dpr: number; //        eg: 1
  };
  scrollWidth: number; //  eg: 1902
  scrollHeight: number; // eg: 23608
  userAgent: string; //    eg: "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0",
  language: string;
}

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
  } satisfies Page;
}

/* ================= in-page banner (prompt / toast) ================= */
export function pageBanner(opts: BannerOpts) {
  const api = typeof browser !== "undefined" ? browser : chrome;

  // self-contained: serialized into the page
  const ID = "__url_archiver_banner__";
  document.getElementById(ID)?.remove();
  const host = document.createElement("div");
  host.id = ID;
  host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;";

  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent =
    ".b{font:14px/1.4 system-ui,sans-serif;color:#fff;background:#1f2937;border-radius:10px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:340px;display:flex;flex-direction:column;gap:10px;word-break:break-word}.b.ok{background:#15803d}.b.err{background:#b91c1c}.r{display:flex;gap:8px;justify-content:flex-end}button{font:inherit;border:0;border-radius:6px;padding:5px 12px;cursor:pointer;background:#fff;color:#111}button.p{background:#3b82f6;color:#fff}.c{display:flex;flex-wrap:wrap;gap:6px}.c button{border-radius:999px;font-size:12px;padding:3px 10px;opacity:.45}.c button.on{opacity:1;outline:1px solid #fff}";
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
  /* Tags chosen in the prompt chip row (top-of-list = to be attached). */
  const chipTags = opts.mode === "prompt" ? (opts.tags ?? []) : [];
  const chosen = new Set(chipTags);

  const archive = async () => {
    render("", "Archiving…", []);

    const result: Result<ArchiveStatus> = await api.runtime.sendMessage({
      type: "ARCHIVE_FROM_PAGE",
      // explicitly selected tags; pending-queue tags merge in the background
      payload: { tags: [...chosen] },
    });

    if (result.ok === true && result.data.state === "ok") {
      const count = result.data.count;

      render("ok", "Archived ✓" + (count ? ` (${count} version${count === 1 ? "" : "s"})` : ""), [
        ["Close", close],
      ]);

      timer = setTimeout(close, 5000);
    } else {
      render("err", `Archive failed: ${JSON.stringify(result, null, 2)}`, [["Close", close]]);
    }
  };

  const renderChips = () => {
    if (!chipTags.length) return undefined;
    const row = document.createElement("div");
    row.className = "c";
    for (const tag of chipTags) {
      const c = document.createElement("button");
      c.textContent = tag.name;
      c.className = chosen.has(tag) ? "on" : "";
      c.title = "Attach tag";
      c.onclick = () => {
        if (chosen.has(tag)) {
          chosen.delete(tag);
          c.className = "";
        } else {
          chosen.add(tag);
          c.className = "on";
        }
      };
      row.append(c);
    }
    // between the text and the action buttons
    box.insertBefore(row, box.querySelector(".r"));
    return row;
  };
  if (opts.mode === "prompt") {
    render("", opts.text || "Archive this page?", [
      ["Dismiss", close],
      ["Archive now", archive, true],
    ]);
    renderChips();
  } else {
    render(opts.kind, opts.text, [["Close", close]]);
    if (opts.kind === "ok") timer = setTimeout(close, 5000);
  }
  document.documentElement.append(host);
}
