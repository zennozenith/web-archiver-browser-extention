(() => {
  const ID = "__url_archiver_banner__";
  const old = document.getElementById(ID);
  if (old) old.remove();

  const host = document.createElement("div");
  host.id = ID;
  host.style.cssText = "all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    .box{font:14px system-ui,sans-serif;display:flex;gap:8px;align-items:center;
      background:#1f2430;color:#fff;padding:10px 12px;border-radius:10px;
      box-shadow:0 6px 24px rgba(0,0,0,.35);border:1px solid #ffffff22}
    .msg{margin-right:4px}
    button{font:inherit;border:0;border-radius:6px;padding:6px 12px;cursor:pointer}
    .go{background:#4f6df5;color:#fff}.no{background:#ffffff1a;color:#fff}
    button:disabled{opacity:.5;cursor:default}`;

  const box = document.createElement("div");
  box.className = "box";
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = "Archive this page?";
  const go = document.createElement("button");
  go.className = "go";
  go.textContent = "Archive";
  const no = document.createElement("button");
  no.className = "no";
  no.textContent = "Dismiss";
  box.append(msg, go, no);
  root.append(style, box);
  document.documentElement.appendChild(host);

  go.addEventListener("click", async () => {
    go.disabled = no.disabled = true;
    msg.textContent = "Archiving…";
    try {
      const r = await browser.runtime.sendMessage({ type: "archiveFromBanner" });
      if (r && r.ok) {
        msg.textContent = "Archived ✓";
        go.style.display = no.style.display = "none";
        setTimeout(() => host.remove(), 1500);
      } else {
        throw new Error((r && r.error) || "Unknown error");
      }
    } catch (e) {
      msg.textContent = "Failed: " + e.message;
      go.textContent = "Retry";
      go.disabled = no.disabled = false;
    }
  });

  no.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "dismissBanner" });
    host.remove();
  });
})();
