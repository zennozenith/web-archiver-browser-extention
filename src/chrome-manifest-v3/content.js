// Injected into the page on demand. The value of the last expression is returned.
(() => {
  const meta = {};
  document.querySelectorAll("meta").forEach((m) => {
    const k = m.getAttribute("property") || m.getAttribute("name") || m.getAttribute("http-equiv");
    const v = m.getAttribute("content");
    if (k && v != null) {
      if (meta[k] === undefined) meta[k] = v;
      else if (Array.isArray(meta[k])) meta[k].push(v);
      else meta[k] = [meta[k], v];
    }
  });
  const dt = document.doctype;
  const doctype = dt
    ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ""}${
        !dt.publicId && dt.systemId ? " SYSTEM" : ""}${dt.systemId ? ` "${dt.systemId}"` : ""}>`
    : "";
  const sel = String(window.getSelection() || "");
  const canonical = document.querySelector('link[rel="canonical"]');
  const feeds = [...document.querySelectorAll('link[rel="alternate"][type*="rss"],link[rel="alternate"][type*="atom"]')]
    .map((l) => l.href);
  const icons = [...document.querySelectorAll('link[rel~="icon"]')].map((l) => l.href);
  return {
    html: doctype + "\n" + document.documentElement.outerHTML,
    url: location.href,
    title: document.title,
    referrer: document.referrer,
    lang: document.documentElement.lang || null,
    charset: document.characterSet,
    contentType: document.contentType,
    lastModified: document.lastModified,
    readyState: document.readyState,
    canonical: canonical ? canonical.href : null,
    description: (meta.description || meta["og:description"] || null),
    meta,
    feeds,
    icons,
    selection: sel || null,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
                scrollX, scrollY, docHeight: document.documentElement.scrollHeight },
    textLength: (document.body ? document.body.innerText.length : 0)
  };
})();
