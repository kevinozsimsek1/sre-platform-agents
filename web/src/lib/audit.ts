import { API } from "./api";
import { identity } from "./identity";

// Sayfa görüntüleme ve tıklamaları toplu halde backend'e gönderir (denetim kaydı).
type Ev = { type: "page_view" | "click" | "action"; page: string; target: string; detail?: string };
let queue: Ev[] = [];
let timer: number | undefined;

function flush() {
  timer = undefined;
  if (!queue.length) return;
  const events = queue.splice(0, 50);
  fetch(API + "/audit/events", {
    method: "POST", keepalive: true, credentials: "same-origin",
    headers: { "content-type": "application/json", ...identity.headers() },
    body: JSON.stringify({ events }),
  }).catch(() => { /* kayıt gönderilemezse kullanıcıyı rahatsız etme */ });
  if (queue.length) schedule();
}
function schedule() { if (!timer) timer = window.setTimeout(flush, 1500); }

export function track(e: Ev) {
  queue.push({ ...e, target: e.target.slice(0, 200), detail: e.detail?.slice(0, 500) });
  schedule();
}

export function installClickTracking() {
  document.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement)?.closest("a,button,[data-audit]") as HTMLElement | null;
    if (!el) return;
    const label = el.dataset.audit || el.getAttribute("aria-label") || el.textContent?.trim().replace(/\s+/g, " ") || el.tagName;
    const href = el.getAttribute("href");
    track({ type: "click", page: location.hash || "/", target: label.slice(0, 120), detail: href || undefined });
  }, { capture: true });
  window.addEventListener("pagehide", flush);
}
