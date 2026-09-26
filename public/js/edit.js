// Edit sheets (event, night, note, JSON) and the save + 409 conflict flow.
import { ApiError } from "./api.js";
import { eventToIcs, icsFilename } from "./ics.js";
import {
  KINDS,
  KIND_LABEL,
  applyChange,
  changeTarget,
  esc,
  resolveConflict,
} from "./model.js";
import * as S from "./session.js";
import {
  $,
  choose,
  closeSheet,
  confirmDialog,
  downloadFile,
  openSheet,
  toast,
} from "./ui.js";

const pretty = (v) => JSON.stringify(v, null, 2);

function reporter(body) {
  const el = $(".status", body);
  return (msg) => {
    el.textContent = msg;
    el.hidden = !msg;
  };
}

// The data and version a sheet was opened on. Saving against this (not the
// live state, which a background refresh may have advanced) is what makes a
// stale edit hit a 409 instead of silently overwriting.
export const snapshotBase = () => ({ data: S.state.data, version: S.state.version });

// Commits `change` on top of `base`. Returns true when the sheet can close
// (saved, or the user chose to keep the other device's version).
export async function saveChange(change, report, base = snapshotBase()) {
  return attempt(
    base.data,
    applyChange(base.data, change),
    base.version,
    change,
    report,
  );
}

async function attempt(base, next, ifMatch, change, report) {
  try {
    await S.commit(next, ifMatch);
    return true;
  } catch (e) {
    if (e instanceof S.ValidationError) report(e.errors.join(" · "));
    else if (e instanceof TypeError) {
      report("Offline. Your edit is still in the form.");
    } else if (e instanceof ApiError && e.status === 409) {
      return resolve409(base, change, report);
    } else if (e instanceof ApiError && e.status === 401) {
      report("Not authorized. Unlock again (More → Forget this device).");
    } else report(`Save failed: ${e.message}`);
    return false;
  }
}

async function resolve409(base, change, report) {
  let latest;
  try {
    latest = await S.fetchLatest();
  } catch {
    report("Couldn't load the latest version. Try again.");
    return false;
  }
  if (change.type === "replace") {
    await choose(
      "Changed on another device. Your text is still in the editor. Close and reopen it to start from the latest version.",
      [{ label: "OK", cls: "primary" }],
    );
    return false;
  }
  const r = resolveConflict(base, latest.data, change);
  if (!r.conflict) {
    const pick = await choose(
      "Changed on another device. Your change was re-applied on top of it.",
      [{ label: "Discard mine" }, { label: "Save", cls: "primary" }],
    );
    if (pick !== "Save") return pick === "Discard mine";
    return attempt(latest.data, r.merged, latest.version, change, report);
  }
  const mine =
    change.type === "upsert"
      ? change.event
      : change.type === "delete"
        ? "(deleted)"
        : change.type === "night"
          ? change.night ?? "(cleared)"
          : change.value;
  const theirs = changeTarget(latest.data, change) ?? "(deleted)";
  const pick = await choose(
    `This was also changed on another device.<div class="cmp">
<div><b>Theirs</b><pre>${esc(pretty(theirs))}</pre></div>
<div><b>Yours</b><pre>${esc(pretty(mine))}</pre></div></div>`,
    [{ label: "Keep theirs" }, { label: "Use mine", cls: "primary" }],
  );
  if (pick !== "Use mine") return pick === "Keep theirs";
  return attempt(
    latest.data,
    applyChange(latest.data, change),
    latest.version,
    change,
    report,
  );
}

const offlineNote = () =>
  S.conn.online ? "" : "Offline. Viewing only; changes need a connection.";

// ---------- event ----------

export function openEventSheet(event, date) {
  const isNew = !event;
  const base = snapshotBase();
  const e = event || { id: crypto.randomUUID(), date, time: "", kind: "activity", title: "" };
  const body = openSheet(`<h3>${isNew ? "New event" : "Edit event"}</h3>
<form id="evform" novalidate>
  <label class="f" for="ev-date">Date</label><input id="ev-date" type="date" name="date" required>
  <div class="grid2">
    <div><label class="f" for="ev-time">Time</label><input id="ev-time" type="time" name="time"></div>
    <div><label class="f" for="ev-end">End</label><input id="ev-end" type="time" name="end"></div>
  </div>
  <label class="f" for="ev-kind">Kind</label>
  <select id="ev-kind" name="kind">${KINDS.map((k) => `<option value="${k}">${KIND_LABEL[k] || "Note"}</option>`).join("")}</select>
  <label class="f" for="ev-title">Title</label><input id="ev-title" name="title" required>
  <label class="f" for="ev-sub">Details</label><input id="ev-sub" name="sub">
  <label class="f" for="ev-where">Where</label><input id="ev-where" name="where">
  <label class="f" for="ev-conf">Confirmation code</label>
  <input id="ev-conf" name="conf" autocapitalize="characters" spellcheck="false">
  <label class="f">Notes</label>
  <div class="notelist"></div>
  <button type="button" class="btn" data-addline style="margin-top:6px">+ Add line</button>
  <p class="status warn" hidden></p>
  <div class="btnrow">
    ${isNew ? "" : '<button type="button" class="btn danger" data-del>Delete</button>'}
    <button type="button" class="btn" data-ics>Add to calendar</button>
    <span class="spacer"></span>
    <button type="button" class="btn" data-cancel>Cancel</button>
    <button type="submit" class="btn primary">Save</button>
  </div>
</form>`);
  const form = $("#evform", body);
  const report = reporter(body);
  for (const k of ["date", "time", "end", "kind", "title", "sub", "where", "conf"]) {
    form[k].value = e[k] || "";
  }
  const lines = $(".notelist", body);
  const addLine = (v = "") => {
    const row = document.createElement("div");
    row.className = "nl";
    row.innerHTML = '<input name="note" aria-label="Note line"><button type="button" class="btn" data-rm aria-label="Remove line">✕</button>';
    row.firstElementChild.value = v;
    lines.append(row);
  };
  (e.notes || []).forEach((n) => addLine(n));

  const readForm = () => {
    const v = (k) => form[k].value.trim();
    const ev = { id: e.id, date: v("date"), time: v("time"), kind: v("kind"), title: v("title") };
    for (const k of ["end", "sub", "where", "conf"]) if (v(k)) ev[k] = v(k);
    const notes = [...lines.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
    if (notes.length) ev.notes = notes;
    return ev;
  };

  const online = S.conn.online;
  form.querySelector('[type="submit"]').disabled = !online;
  const del = form.querySelector("[data-del]");
  if (del) del.disabled = !online;
  report(offlineNote());

  form.onclick = async (ev) => {
    const t = ev.target;
    if (t.closest("[data-addline]")) return addLine();
    if (t.closest("[data-rm]")) return t.closest(".nl").remove();
    if (t.closest("[data-cancel]")) return closeSheet();
    if (t.closest("[data-ics]")) {
      const cur = readForm();
      if (!cur.date || !cur.title) return report("Date and title are needed for the calendar.");
      return downloadFile(icsFilename(cur), eventToIcs(cur, S.state.data.tz || "-03:00"), "text/calendar");
    }
    if (t.closest("[data-del]")) {
      const ok = await confirmDialog(`Delete “${esc(e.title)}”?`, "Delete", "danger");
      if (ok && (await saveChange({ type: "delete", id: e.id }, report, base))) {
        closeSheet();
        toast("Deleted");
      }
    }
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    const ok = await saveChange({ type: "upsert", event: readForm() }, report, base);
    btn.disabled = !S.conn.online;
    if (ok) {
      closeSheet();
      toast("Saved");
    }
  };
}

// ---------- night ----------

export function openNightSheet(date) {
  const night = S.state.data.nights[date];
  const base = snapshotBase();
  const body = openSheet(`<h3>Lodging, night of ${esc(date)}</h3>
<form id="nform">
  <label class="f" for="n-name">Name</label><input id="n-name" name="name" required>
  <label class="f" for="n-sub">Details</label><input id="n-sub" name="sub">
  <p class="status warn" hidden></p>
  <div class="btnrow">
    ${night ? '<button type="button" class="btn danger" data-clear>Clear</button>' : ""}
    <span class="spacer"></span>
    <button type="button" class="btn" data-cancel>Cancel</button>
    <button type="submit" class="btn primary">Save</button>
  </div>
</form>`);
  const form = $("#nform", body);
  const report = reporter(body);
  form.name.value = night?.name || "";
  form.sub.value = night?.sub || "";
  const online = S.conn.online;
  for (const b of form.querySelectorAll('[type="submit"], [data-clear]')) b.disabled = !online;
  report(offlineNote());
  const save = async (value) => {
    if (await saveChange({ type: "night", date, night: value }, report, base)) {
      closeSheet();
      toast("Saved");
    }
  };
  form.onclick = (ev) => {
    if (ev.target.closest("[data-cancel]")) closeSheet();
    if (ev.target.closest("[data-clear]")) save(null);
  };
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const name = form.name.value.trim();
    if (!name) return report("Name is required.");
    const sub = form.sub.value.trim();
    save(sub ? { name, sub } : { name });
  };
}

// ---------- notes (work offline) ----------

export function openNoteSheet(date) {
  const body = openSheet(`<h3>Note for ${esc(date)}</h3>
<form id="noteform">
  <textarea name="text" rows="4" aria-label="Note" placeholder="Room number, wifi code, anything…"></textarea>
  <p class="status ${S.conn.online ? "ok" : "warn"}">${
    S.conn.online
      ? "Saves on this device and syncs now."
      : "Offline. Saved on this device and will sync when you're back online."
  }</p>
  <div class="btnrow"><span class="spacer"></span>
    <button type="button" class="btn" data-cancel>Cancel</button>
    <button type="submit" class="btn primary">Save note</button>
  </div>
</form>`);
  const form = $("#noteform", body);
  form.text.focus();
  form.onclick = (ev) => ev.target.closest("[data-cancel]") && closeSheet();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const text = form.text.value.trim();
    if (!text) return closeSheet();
    await S.addNoteRecord({ date, text });
    closeSheet();
    toast("Note saved");
  };
}

export async function confirmDeleteNote(id) {
  const rec = S.state.noteRecs.get(id);
  if (!rec) return;
  const preview = esc(rec.text.length > 80 ? `${rec.text.slice(0, 80)}…` : rec.text);
  if (await confirmDialog(`Delete this note?<br><small>${preview}</small>`, "Delete", "danger")) {
    await S.addNoteRecord({ del: id });
    toast("Note deleted");
  }
}

// ---------- JSON editors ----------

const JSON_TITLES = { cities: "Cities", costs: "Costs", json: "Everything (raw JSON)" };

export function openJsonEditor(kind) {
  const base = snapshotBase();
  const value = kind === "json" ? base.data : base.data[kind];
  const body = openSheet(`<h3>${JSON_TITLES[kind]}</h3>
<form id="jform">
  <textarea class="code" name="text" spellcheck="false" aria-label="JSON"></textarea>
  <p class="status warn" hidden></p>
  <div class="btnrow">
    ${kind === "json" ? '<button type="button" class="btn" data-download>Download JSON</button>' : ""}
    <span class="spacer"></span>
    <button type="button" class="btn" data-cancel>Cancel</button>
    <button type="submit" class="btn primary">Save</button>
  </div>
</form>`);
  const form = $("#jform", body);
  const report = reporter(body);
  form.text.value = pretty(value);
  form.querySelector('[type="submit"]').disabled = !S.conn.online;
  report(offlineNote());
  form.onclick = (ev) => {
    if (ev.target.closest("[data-cancel]")) closeSheet();
    if (ev.target.closest("[data-download]")) {
      // Plaintext export (for passphrase rotation): itinerary + notes.
      const notes = S.notes().map(({ date, text, createdAt }) => ({ date, text, createdAt }));
      const day = new Date().toLocaleDateString("en-CA");
      downloadFile(`itinerary-${day}.json`, pretty({ ...S.state.data, notes }), "application/json");
    }
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    let parsed;
    try {
      parsed = JSON.parse(form.text.value);
    } catch (e) {
      return report(`Not valid JSON: ${e.message}`);
    }
    let change;
    if (kind === "json") {
      const { notes, ...rest } = parsed ?? {};
      change = { type: "replace", data: S.withIds(rest) };
    } else change = { type: "field", key: kind, value: parsed };
    if (await saveChange(change, report, base)) {
      closeSheet();
      toast("Saved");
    }
  };
}

export function install(handlers, { currentDate }) {
  handlers.click = (ev) => {
    const t = ev.target;
    if (t.closest("#fab-add")) return openEventSheet(null, currentDate());
    if (t.closest("#fab-note")) return openNoteSheet(currentDate());
    const row = t.closest(".row[data-id]");
    if (row) {
      const e = S.state.data.events.find((x) => x.id === row.dataset.id);
      if (e) openEventSheet(e);
      return;
    }
    const night = t.closest("[data-night]");
    if (night) openNightSheet(night.dataset.night);
  };
  handlers.deleteNote = confirmDeleteNote;
  const prevMore = handlers.more;
  handlers.more = (action) => {
    if (["cities", "costs", "json"].includes(action)) return openJsonEditor(action);
    prevMore?.(action);
  };
}
