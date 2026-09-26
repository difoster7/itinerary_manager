// Standalone snapshot, print, and version history.
import { saveChange, snapshotBase } from "./edit.js";
import { esc, summarize } from "./model.js";
import { renderSnapshotBody } from "./render.js";
import * as S from "./session.js";
import { $, choose, closeSheet, downloadFile, openSheet, toast } from "./ui.js";

// Inline script for the snapshot file: tap-to-copy and jump to today.
const SNAPSHOT_JS = `document.addEventListener("click", function (e) {
  var c = e.target.closest("[data-copy]");
  if (c && navigator.clipboard) navigator.clipboard.writeText(c.getAttribute("data-copy"));
});
var t = document.getElementById("d" + new Date().toLocaleDateString("en-CA"));
if (t) t.scrollIntoView();`;

export function buildSnapshot(data, notes, css, generatedAt) {
  const today = new Date().toLocaleDateString("en-CA");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(data.title)}</title>
<style>${css}</style></head>
<body><div class="snap">
<header><h1>${esc(data.title)}</h1><p>${esc(data.subtitle || "")}</p>
<p>Snapshot generated ${esc(generatedAt)}. Plaintext copy; keep it private.</p></header>
${renderSnapshotBody(data, notes, today)}
</div><script>${SNAPSHOT_JS}</script></body></html>`;
}

export const snapshotFilename = (d) =>
  `Itinerary-snapshot-${d.toLocaleDateString("en-CA")}.html`;

async function downloadSnapshot() {
  const css = await (await fetch("/styles.css")).text();
  const now = new Date();
  const stamp = `${now.toLocaleDateString("en-CA")} ${now.toTimeString().slice(0, 5)}`;
  downloadFile(
    snapshotFilename(now),
    buildSnapshot(S.state.data, S.notes(), css, stamp),
    "text/html",
  );
}

function print() {
  const root = $("#print-root");
  root.innerHTML = `<div class="snap">${renderSnapshotBody(
    S.state.data,
    S.notes(),
    new Date().toLocaleDateString("en-CA"),
  )}</div>`;
  document.body.classList.add("printing");
  addEventListener(
    "afterprint",
    () => {
      document.body.classList.remove("printing");
      root.innerHTML = "";
    },
    { once: true },
  );
  window.print();
}

async function openHistory() {
  if (!S.conn.online) return toast("History needs a connection");
  const body = openSheet(`<h3>Version history</h3><p class="hint">Loading…</p><div class="morelist"></div>`);
  let list;
  try {
    list = await S.history();
  } catch {
    $(".hint", body).textContent = "Couldn't load history. Check your connection.";
    return;
  }
  $(".hint", body).textContent = `${list.length} saved versions. Tap one to preview.`;
  const box = $(".morelist", body);
  box.innerHTML = list
    .map(
      (v) => `<button type="button" class="btn histrow" data-v="${v.version}">
  <span>v${v.version}${v.version === S.state.version ? " · current" : ""}<br><small>${esc(new Date(v.updatedAt).toLocaleString())}</small></span>
  <small class="sum">…</small></button>`,
    )
    .join("");
  box.onclick = (e) => {
    const b = e.target.closest("[data-v]");
    if (b) previewVersion(Number(b.dataset.v));
  };
  // Summaries are decrypted on this device, one version at a time.
  for (const b of box.querySelectorAll("[data-v]")) {
    try {
      const d = await S.historyVersion(Number(b.dataset.v));
      $(".sum", b).textContent = summarize(d);
    } catch {
      $(".sum", b).textContent = "";
    }
    if (!body.isConnected) return;
  }
}

async function previewVersion(v) {
  let data;
  try {
    data = await S.historyVersion(v);
  } catch {
    return toast("Couldn't load that version");
  }
  const isCurrent = v === S.state.version;
  const base = snapshotBase();
  const body = openSheet(`<h3>Version ${v}</h3>
<p class="hint">${esc(summarize(data))}. Read-only preview.</p>
<div class="preview">${renderSnapshotBody(data, [], "")}</div>
<p class="status warn" hidden></p>
<div class="btnrow"><button type="button" class="btn" data-back>Back</button><span class="spacer"></span>
${isCurrent ? "" : '<button type="button" class="btn primary" data-restore>Restore this version</button>'}</div>`);
  const report = (m) => {
    const el = $(".status", body);
    el.textContent = m;
    el.hidden = !m;
  };
  body.onclick = async (e) => {
    if (e.target.closest("[data-back]")) return openHistory();
    if (!e.target.closest("[data-restore]")) return;
    const pick = await choose(
      `Restore version ${v}? It's saved as a new version, so this can be undone.`,
      [{ label: "Cancel" }, { label: "Restore", cls: "primary" }],
    );
    if (pick !== "Restore") return;
    if (await saveChange({ type: "replace", data }, report, base)) {
      closeSheet();
      toast(`Restored version ${v}`);
    }
  };
}

export function install(handlers) {
  const prev = handlers.more;
  handlers.more = (action) => {
    if (action === "snapshot") return downloadSnapshot();
    if (action === "print") return print();
    if (action === "history") return openHistory();
    prev?.(action);
  };
}
