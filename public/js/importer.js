// Confirmation import: paste/upload sheet, Android share pickup, the Claude
// call, the one-version save, and the result sheet with Undo. Named importer
// to keep it apart from the seed-import screen.
import { ApiError } from "./api.js";
import { openEventSheet, saveChange, snapshotBase } from "./edit.js";
import { ACCEPT, extract, readFile, tripContext } from "./extract.js";
import { dayLabel } from "./render.js";
import { esc, mergeImport } from "./model.js";
import * as S from "./session.js";
import * as store from "./store.js";
import { $, closeSheet, openSheet, toast } from "./ui.js";

const apiKey = () => S.state.data?.settings?.anthropicKey;
const todayISO = () => new Date().toLocaleDateString("en-CA");
let busy = false;

// ---------- key ----------

function openKeySheet(reason = "") {
  const base = snapshotBase();
  const has = !!apiKey();
  const body = openSheet(`<h3>Anthropic API key</h3>
<form id="kform">
  ${reason ? `<p class="muted">${esc(reason)}</p>` : ""}
  <p class="muted">Import sends confirmations to Claude with this key. It's stored
    encrypted with your itinerary and syncs to your devices.</p>
  <input type="password" name="key" aria-label="API key" autocomplete="off"
         spellcheck="false" placeholder="${has ? "Saved. Paste to replace." : "sk-ant-…"}">
  <p class="status warn" hidden></p>
  <div class="btnrow">
    ${has ? '<button type="button" class="btn danger" data-remove>Remove</button>' : ""}
    <span class="spacer"></span>
    <button type="button" class="btn" data-cancel>Cancel</button>
    <button type="submit" class="btn primary">Save</button>
  </div>
</form>`);
  const form = $("#kform", body);
  const status = $(".status", body);
  const report = (m) => {
    status.textContent = m;
    status.hidden = !m;
  };
  if (!S.conn.online) {
    report("Offline. Changes need a connection.");
    for (const b of form.querySelectorAll("[type=submit], [data-remove]")) b.disabled = true;
  }
  const save = async (key) => {
    const { anthropicKey, ...rest } = base.data.settings || {};
    const value = key ? { ...rest, anthropicKey: key } : rest;
    if (await saveChange({ type: "field", key: "settings", value }, report, base)) {
      closeSheet();
      toast(key ? "Key saved" : "Key removed");
    }
  };
  form.onclick = (ev) => {
    if (ev.target.closest("[data-cancel]")) closeSheet();
    if (ev.target.closest("[data-remove]")) save("");
  };
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const key = form.key.value.trim();
    if (!key) return report("Paste a key first.");
    save(key);
  };
}

// ---------- import sheet ----------

function openImportSheet() {
  if (!apiKey()) return openKeySheet("Add your key to import confirmations.");
  const body = openSheet(`<h3>Import confirmation</h3>
<form id="cform">
  <textarea name="text" rows="6" aria-label="Confirmation text"
            placeholder="Paste the confirmation email, or paste a screenshot…"></textarea>
  <label class="f" for="c-file">Or a PDF or screenshot</label>
  <input id="c-file" type="file" name="file" accept="${ACCEPT.join(",")}">
  <p class="status" hidden></p>
  <div class="btnrow"><span class="spacer"></span>
    <button type="button" class="btn" data-cancel>Cancel</button>
    <button type="submit" class="btn primary">Import</button>
  </div>
</form>`);
  const form = $("#cform", body);
  const status = $(".status", body);
  const report = (m, cls = "warn") => {
    status.className = `status ${cls}`;
    status.textContent = m;
    status.hidden = !m;
  };
  let file = null;
  const pick = (f) => {
    file = f;
    report(f ? `Attached: ${f.name || "pasted image"}` : "", "ok");
  };
  form.file.onchange = () => pick(form.file.files[0] || null);
  form.text.addEventListener("paste", (ev) => {
    const img = [...(ev.clipboardData?.files || [])].find((f) => ACCEPT.includes(f.type));
    if (!img) return;
    ev.preventDefault();
    pick(img);
  });
  body.addEventListener("dragover", (ev) => ev.preventDefault());
  body.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const f = ev.dataTransfer?.files[0];
    if (f) pick(f);
  });
  form.onclick = (ev) => ev.target.closest("[data-cancel]") && closeSheet();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const text = form.text.value.trim();
    if (!text && !file) return report("Paste text or choose a file.");
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    report("Reading confirmation…", "ok");
    const err = await run({ text, file });
    btn.disabled = false;
    if (err) report(err);
  };
}

// ---------- pipeline ----------

// Re-merging on a 409 is safe: mergeImport skips anything already present.
async function save(result) {
  let base = snapshotBase();
  for (let attempt = 0; ; attempt++) {
    const m = mergeImport(base.data, result);
    if (m.next === base.data) return { ...m, before: base.data };
    try {
      await S.commit(m.next, base.version);
      return { ...m, before: base.data };
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409) || attempt) throw e;
      base = await S.fetchLatest();
    }
  }
}

// Returns an error message for the calling sheet, or "" once the result
// sheet is showing.
async function run(source) {
  if (busy) return "An import is already running.";
  busy = true;
  try {
    const src = { text: source.text };
    if (source.file) src.file = await readFile(source.file);
    const result = await extract(src, {
      apiKey: apiKey(),
      context: tripContext(S.state.data, todayISO()),
    });
    showResult(await save(result), source);
    return "";
  } catch (e) {
    if (e instanceof S.ValidationError) return e.errors.join(" · ");
    if (e instanceof TypeError) return "Offline. Try again with a connection.";
    return e.message;
  } finally {
    busy = false;
  }
}

function eventLine(e) {
  const l = dayLabel(e.date);
  const when = `${l.short} ${l.mon} ${l.day}${e.time ? ` ${e.time}` : ""}`;
  return `<li>${esc(when)} · ${esc(e.title)}</li>`;
}

function showResult({ added, warnings, next, before }, source) {
  const parts = [
    [added.events.length, "event", "events"],
    [added.nights.length, "night", "nights"],
    [added.costs, "cost", "costs"],
  ]
    .filter(([n]) => n)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  const any = parts.length > 0;
  const body = openSheet(`<h3>${any ? "Imported" : "Nothing imported"}</h3>
${any ? `<p class="muted">${parts.join(" · ")}</p>` : ""}
${added.events.length ? `<ul class="imported">${added.events.map(eventLine).join("")}</ul>` : ""}
${!any && !warnings.length ? '<p class="muted">No bookings found.</p>' : ""}
${warnings.length ? `<ul class="status warn">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
<p class="status warn" hidden></p>
<div class="btnrow">
  ${any ? '<button type="button" class="btn danger" data-undo>Undo</button>' : '<button type="button" class="btn" data-retry>Retry</button><button type="button" class="btn" data-manual>Add manually</button>'}
  ${added.events.length ? '<button type="button" class="btn" data-edit>Edit</button>' : ""}
  <span class="spacer"></span>
  <button type="button" class="btn primary" data-done>Done</button>
</div>`);
  const status = body.querySelector("p.status");
  const report = (m) => {
    status.textContent = m;
    status.hidden = !m;
  };
  body.onclick = async (ev) => {
    const t = ev.target;
    if (t.closest("[data-done]")) return closeSheet();
    if (t.closest("[data-edit]")) return openEventSheet(added.events[0]);
    if (t.closest("[data-manual]")) return openEventSheet(null, todayISO());
    if (t.closest("[data-retry]")) {
      report("Reading confirmation…");
      const err = await run(source);
      if (err) report(err);
      return;
    }
    if (t.closest("[data-undo]")) {
      const changed =
        "Changed since the import, so it can't be undone. Delete the entries by hand.";
      if (S.state.data !== next) return report(changed);
      t.disabled = true;
      try {
        await S.commit(before);
        closeSheet();
        toast("Import undone");
      } catch (e) {
        t.disabled = false;
        report(
          e instanceof ApiError && e.status === 409
            ? changed
            : `Undo failed: ${e.message}`,
        );
      }
    }
  };
}

// ---------- Android share ----------

// sw.js stores shared text/files under kv "share" and redirects here.
export async function pickupShare() {
  if (location.search.includes("shared=lost")) {
    history.replaceState(null, "", "/");
    return toast("The share didn't reach the app. Share it again.");
  }
  if (busy || !S.state.data) return;
  const share = await store.get("kv", "share");
  if (!share) return;
  if (!S.conn.online) return toast("Shared confirmation waits for a connection");
  if (!apiKey()) {
    return openKeySheet("Add your key; the shared confirmation imports when you reopen the app.");
  }
  await store.del("kv", "share");
  const text = [share.title, share.text].filter(Boolean).join("\n");
  if (!text && !share.file) return toast("Nothing was shared");
  if (location.search) history.replaceState(null, "", "/");
  const body = openSheet(`<h3>Reading confirmation…</h3>
<p class="muted">This takes a few seconds.</p><p class="status warn" hidden></p>
<div class="btnrow"><span class="spacer"></span>
  <button type="button" class="btn" data-close hidden>Close</button></div>`);
  const err = await run({ text, file: share.file });
  if (err) {
    const status = $(".status", body);
    status.textContent = err;
    status.hidden = false;
    const close = $("[data-close]", body);
    close.hidden = false;
    close.onclick = closeSheet;
  }
}

export function install(handlers) {
  const prevClick = handlers.click;
  handlers.click = (ev) => {
    if (ev.target.closest("#fab-import")) return openImportSheet();
    prevClick?.(ev);
  };
  const prevMore = handlers.more;
  handlers.more = (action) => {
    if (action === "claude") return openKeySheet();
    prevMore?.(action);
  };
}
