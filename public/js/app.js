import { install as installEdit } from "./edit.js";
import { install as installExport } from "./export.js";
import { openingDate, resumeDate, tripDates } from "./model.js";
import {
  renderCodes,
  renderDay,
  renderDayList,
  renderNotesTab,
  renderOverview,
} from "./render.js";
import * as S from "./session.js";
import { $, confirmDialog, copyText, toast } from "./ui.js";

const view = { current: null, tab: "trip", noteHold: false, lastToday: null };
const todayISO = () => new Date().toLocaleDateString("en-CA");
const nowHHMM = () => new Date().toTimeString().slice(0, 5);

function show(screen) {
  for (const id of ["lock", "import", "app"]) $(`#${id}`).hidden = id !== screen;
}

function relTime(iso) {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const syncLabel = () =>
  `${S.conn.online ? "" : "Offline · "}Synced ${relTime(S.state.syncedAt)}`;

export function rerender() {
  const d = S.state.data;
  if (!d) return;
  const dates = tripDates(d);
  const today = todayISO();
  view.current = dates.includes(view.current)
    ? resumeDate(dates, view.current, view.lastToday, today)
    : openingDate(dates, today);
  view.lastToday = today;
  const online = S.conn.online;
  $("#banner").hidden = online;
  $("#fab-add").disabled = !online;
  $("#side-title").textContent = d.title;
  $("#side-sync").textContent = syncLabel();
  $("#daylist").innerHTML = renderDayList(d, dates, view.current);
  for (const b of document.querySelectorAll(".tabs [data-tab]")) {
    if (b.dataset.tab === view.tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  for (const t of ["trip", "notes", "codes", "more"]) {
    $(`#view-${t}`).hidden = t !== view.tab;
  }
  $("#fabs").hidden = view.tab !== "trip";
  const notes = S.notes();
  if (view.tab === "trip") {
    $("#day").innerHTML = view.current
      ? renderDay(d, view.current, {
          notes,
          dates,
          todayISO: todayISO(),
          nowHHMM: nowHHMM(),
          syncLabel: syncLabel(),
        })
      : '<p class="empty">No days yet. Tap + to add an event.</p>';
  } else if (view.tab === "notes") {
    $("#view-notes").innerHTML = renderNotesTab(d, notes);
  } else if (view.tab === "codes") {
    $("#view-codes").innerHTML = renderCodes(d);
  } else {
    renderMore(d);
  }
}

function renderMore(d) {
  $("#view-more").innerHTML = `${renderOverview(d)}
<h2 class="sec">Data</h2>
<div class="morelist">
  <button type="button" class="btn" data-action="history">Version history</button>
  <button type="button" class="btn" data-action="cities">Edit cities (JSON)</button>
  <button type="button" class="btn" data-action="costs">Edit costs (JSON)</button>
  <button type="button" class="btn" data-action="json">Raw JSON (everything)</button>
</div>
<h2 class="sec">Backup</h2>
<div class="morelist">
  <button type="button" class="btn" data-action="snapshot">Download snapshot (HTML)</button>
  <button type="button" class="btn" data-action="print">Print</button>
</div>
<h2 class="sec">This device</h2>
<div class="morelist">
  <button type="button" class="btn danger" data-action="forget">Forget this device</button>
</div>
<p class="meta" id="device-meta">${syncLabel()}</p>`;
  deviceMeta();
}

async function deviceMeta() {
  const parts = [syncLabel()];
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  parts.push(
    persisted ? "Storage: protected" : "Storage: may be cleared by Chrome",
  );
  const version = await swVersion();
  if (version) parts.push(`App ${version.slice(0, 8)}`);
  const el = $("#device-meta");
  if (el) el.textContent = parts.join(" · ");
}

function swVersion() {
  const sw = navigator.serviceWorker?.controller;
  if (!sw) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data?.version || null);
    sw.postMessage({ type: "version" }, [ch.port2]);
    setTimeout(() => resolve(null), 1000);
  });
}

function go(date) {
  view.current = date;
  view.tab = "trip";
  rerender();
  scrollTo({ top: 0 });
}

function step(n) {
  const dates = tripDates(S.state.data);
  const i = dates.indexOf(view.current) + n;
  if (i >= 0 && i < dates.length) go(dates[i]);
}

async function afterRefresh(status) {
  if (status === "unauthorized") {
    show("lock");
    $("#lock .err").textContent = "Passphrase changed? Unlock again.";
    return;
  }
  if (status === "empty" && !S.state.data) return show("import");
  if (S.state.data) {
    show("app");
    rerender();
    if (status === "updated") toast("Updated");
  } else if (status === "offline") {
    show("app");
    $("#day").innerHTML =
      '<p class="empty">No saved copy yet. Connect once to download.</p>';
  }
}

const refresh = async () => afterRefresh(await S.refresh());

// ---------- events ----------

$("#lock-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const err = $(".err", form);
  const btn = $("button", form);
  btn.disabled = true;
  err.textContent = "Unlocking…";
  try {
    const status = await S.unlock(form.pass.value);
    err.textContent = {
      wrong: "Wrong passphrase.",
      offline: "First unlock needs a connection.",
    }[status] || "";
    if (status === "empty") show("import");
    else if (status === "ok") {
      form.reset();
      await afterRefresh("ok");
    }
  } catch (e) {
    err.textContent = `Unlock failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("#import-file").addEventListener("change", async (ev) => {
  const list = $("#import-errors");
  list.innerHTML = "";
  const file = ev.target.files[0];
  if (!file) return;
  let errs;
  try {
    errs = await S.importData(JSON.parse(await file.text()));
  } catch (e) {
    errs = [`Couldn't read the file: ${e.message}`];
  }
  if (errs.length) {
    for (const m of errs) {
      const li = document.createElement("li");
      li.textContent = m;
      list.append(li);
    }
    return;
  }
  await refresh();
});

document.addEventListener("click", async (ev) => {
  const t = ev.target;
  const copy = t.closest("[data-copy]");
  if (copy) {
    if (view.noteHold) return (view.noteHold = false);
    return copyText(copy.dataset.copy);
  }
  const tab = t.closest(".tabs [data-tab]");
  if (tab) {
    view.tab = tab.dataset.tab;
    rerender();
    return scrollTo({ top: 0 });
  }
  const date = t.closest(".strip [data-date], #daylist [data-date], .ngroup [data-date]");
  if (date) return go(date.dataset.date);
  const action = t.closest("#view-more [data-action]");
  if (action) return moreAction(action.dataset.action);
  handlers.click?.(ev);
});

async function moreAction(action) {
  if (action === "forget") {
    const ok = await confirmDialog(
      "Remove the key and saved copy from this device? You'll need the passphrase again.",
      "Forget",
      "danger",
    );
    if (!ok) return;
    await S.forget();
    location.reload();
    return;
  }
  handlers.more?.(action);
}

// Filled in by edit.js / export.js so this module stays wiring-only.
export const handlers = {};

// Swipe between days; touch-action: pan-y leaves vertical scroll alone.
const swipe = { id: null, x: 0, y: 0 };
$("#view-trip").addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse") return;
  Object.assign(swipe, { id: e.pointerId, x: e.clientX, y: e.clientY });
});
$("#view-trip").addEventListener("pointerup", (e) => {
  if (e.pointerId !== swipe.id) return;
  swipe.id = null;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
});
$("#view-trip").addEventListener("pointercancel", () => (swipe.id = null));

// Long-press a note to delete it.
let holdTimer;
document.addEventListener("pointerdown", (e) => {
  const nt = e.target.closest("[data-note-id]");
  if (!nt) return;
  holdTimer = setTimeout(() => {
    view.noteHold = true;
    handlers.deleteNote?.(nt.dataset.noteId);
  }, 550);
});
for (const t of ["pointerup", "pointercancel", "pointermove"]) {
  document.addEventListener(t, (e) => {
    if (t === "pointermove" && Math.abs(e.movementX) + Math.abs(e.movementY) < 4) return;
    clearTimeout(holdTimer);
  });
}
document.addEventListener("contextmenu", (e) => {
  if (e.target.closest("[data-note-id]")) e.preventDefault();
});

document.addEventListener("keydown", (e) => {
  if (!S.state.data || view.tab !== "trip" || document.querySelector("dialog[open]")) return;
  if (e.target.closest?.("input, textarea, select")) return;
  if (e.key === "ArrowRight") step(1);
  if (e.key === "ArrowLeft") step(-1);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.state.api) refresh();
});
S.conn.subscribe((online) => {
  if (online && S.state.api) refresh();
  else rerender();
});
S.onChange(() => rerender());
// Re-render each tick on today (countdowns) and when the date rolls over.
setInterval(() => {
  const today = todayISO();
  if (view.current === today || view.lastToday !== today) rerender();
}, 30000);

export const currentDate = () => view.current;
installEdit(handlers, { currentDate });
installExport(handlers);

// ---------- boot ----------

async function boot() {
  navigator.serviceWorker?.register("/sw.js", { type: "module" }).catch(() => {});
  if (!(await S.loadKeys())) return show("lock");
  await S.loadLocal();
  if (S.state.data) {
    show("app");
    rerender();
  }
  await refresh();
}

boot();
