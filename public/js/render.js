// HTML-string renderers. Every user value goes through esc().
import {
  KIND_LABEL,
  confRows,
  countdown,
  dayEvents,
  esc,
  timelineState,
  tripDates,
  tripStats,
} from "./model.js";

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PLURAL = {
  flight: ["flight", "flights"],
  bus: ["bus", "buses"],
  transfer: ["transfer", "transfers"],
  stay: ["stay", "stays"],
  trek: ["trek day", "trek days"],
  activity: ["activity", "activities"],
  food: ["meal", "meals"],
  show: ["event", "events"],
  note: ["note", "notes"],
};

const count = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;

export function dayLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { mon: MON[m - 1], day: d, dow, short: dow.slice(0, 3) };
}

const shortDate = (iso) => {
  const l = dayLabel(iso);
  return `${l.short} ${l.mon} ${l.day}`;
};

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// "Night 2/5" for consecutive nights at the same place.
function nightRun(nights, iso) {
  const name = nights[iso].name;
  let first = iso;
  while (nights[addDays(first, -1)]?.name === name) first = addDays(first, -1);
  let last = iso;
  while (nights[addDays(last, 1)]?.name === name) last = addDays(last, 1);
  const idx = (Date.parse(iso) - Date.parse(first)) / 864e5 + 1;
  const len = (Date.parse(last) - Date.parse(first)) / 864e5 + 1;
  return len > 1 ? `Night ${idx}/${len}` : "Night";
}

const noteTime = (createdAt) =>
  new Date(createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

const confChip = (conf) =>
  `<button type="button" class="conf" data-copy="${esc(conf)}"><b>Conf</b>${esc(conf)}</button>`;

function eventRow(e, state, nowHHMM) {
  const label = KIND_LABEL[e.kind];
  let tag = "";
  if (state === "next") {
    tag = `<span class="nextlab">NEXT · ${countdown(nowHHMM, e.time)}</span>`;
  } else if (state === "now") tag = `<span class="nextlab">NOW</span>`;
  return `<div class="row k-${esc(e.kind)}${state ? ` ${state}` : ""}" data-id="${esc(e.id)}">
  <div class="t">${e.time ? esc(e.time) : "All day"}${e.end ? `<em>${esc(e.end)}</em>` : ""}</div>
  <div class="dot"></div>
  <div class="c">${tag}${label ? `<div class="k">${label}</div>` : ""}
    <div class="ti">${esc(e.title)}</div>
    ${e.sub ? `<div class="su">${esc(e.sub)}</div>` : ""}
    ${e.where ? `<div class="wh">${esc(e.where)}</div>` : ""}
    ${e.notes?.length ? `<ul class="enotes">${e.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    ${e.conf ? confChip(e.conf) : ""}
  </div>
</div>`;
}

function noteItem(n) {
  return `<div class="nt" data-note-id="${esc(n.id)}" data-copy="${esc(n.text)}">
  <div class="x">${esc(n.text)}<small>${noteTime(n.createdAt)}${n.queued ? ' · <span class="q">● queued</span>' : ""}</small></div>
</div>`;
}

export function renderDay(d, iso, { notes, dates, todayISO, nowHHMM, syncLabel }) {
  const l = dayLabel(iso);
  const evs = dayEvents(d, iso);
  const st = iso === todayISO ? timelineState(evs, nowHHMM) : {};
  const night = d.nights[iso];
  const dayNotes = notes.filter((n) => n.date === iso);
  const strip = dates
    .map((x) => {
      const cls = x < iso ? "p" : x === iso ? "n" : "";
      return `<button type="button" class="${cls}" data-date="${x}" aria-label="${shortDate(x)}"></button>`;
    })
    .join("");
  return `<header class="dhd">
  <div class="big"><small>${l.short} · Day ${dates.indexOf(iso) + 1} of ${dates.length}</small>${l.mon} ${l.day}</div>
  <div class="city">${esc(d.cities[iso] || "")}<div class="sync">${esc(syncLabel)}</div></div>
</header>
<div class="strip">${strip}</div>
<div class="tl">${evs.length ? evs.map((e) => eventRow(e, st[e.id], nowHHMM)).join("") : '<p class="empty">Nothing scheduled</p>'}</div>
<button type="button" class="nightB${night ? "" : " none"}" data-night="${iso}">${
    night
      ? `<span>${nightRun(d.nights, iso)}</span><b>${esc(night.name)}</b>${night.sub ? ` · ${esc(night.sub)}` : ""}`
      : "<span>Night</span>No lodging set"
  }</button>
<section class="notes">
  <h5><span>Notes</span><span>${dayNotes.length || ""}</span></h5>
  ${dayNotes.length ? dayNotes.map(noteItem).join("") : '<p class="hint">No notes for this day.</p>'}
</section>`;
}

export function renderDayList(d, dates, selected) {
  return dates
    .map((iso) => {
      const titles = dayEvents(d, iso).map((e) => esc(e.title)).join(" · ");
      return `<button type="button" class="dl${iso === selected ? " on" : ""}" data-date="${iso}">
  <b>${shortDate(iso)}</b><span class="c2">${esc(d.cities[iso] || "")}</span>
  <span class="pv">${titles || "—"}</span>
</button>`;
    })
    .join("");
}

function codesTable(d) {
  const rows = confRows(d)
    .map(
      (e) => `<tr><td class="mono">${shortDate(e.date)}</td><td>${esc(e.title)}</td>
<td>${confChip(e.conf)}</td><td>${esc(e.where || "")}</td></tr>`,
    )
    .join("");
  return `<div class="tablewrap"><table><thead><tr><th>Date</th><th>What</th><th>Code</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function costsTable(d) {
  const rows = d.costs
    .map(
      ([a, b, c]) =>
        `<tr><td>${esc(a)}</td><td class="mono">${esc(b)}</td><td>${esc(c ?? "")}</td></tr>`,
    )
    .join("");
  return `<div class="tablewrap"><table><thead><tr><th>Item</th><th>Amount</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export const renderCodes = (d) =>
  `<h2 class="sec">Confirmation codes</h2>${confRows(d).length ? codesTable(d) : '<p class="empty">No confirmation codes yet.</p>'}`;

export function renderNotesTab(d, notes) {
  if (!notes.length) {
    return '<h2 class="sec">Notes</h2><p class="empty">No notes yet. Add one from any day with ✎ Note.</p>';
  }
  const byDate = new Map();
  for (const n of notes) byDate.set(n.date, [...(byDate.get(n.date) || []), n]);
  const groups = [...byDate.keys()]
    .sort()
    .map(
      (iso) => `<section class="ngroup"><h3 data-date="${esc(iso)}">${shortDate(iso)}${d.cities[iso] ? ` · ${esc(d.cities[iso])}` : ""}</h3>
<div class="notes">${byDate.get(iso).map(noteItem).join("")}</div></section>`,
    )
    .join("");
  return `<h2 class="sec">Notes</h2>${groups}`;
}

export function renderOverview(d) {
  const { nights, byKind } = tripStats(d);
  const kinds = Object.keys(PLURAL)
    .filter((k) => byKind[k] && k !== "note")
    .map((k) => count(byKind[k], PLURAL[k]))
    .join(" · ");
  return `<h2 class="sec">Overview</h2>
<div class="chips"><span class="chipstat ok">${count(nights, ["night", "nights"])}</span>${kinds ? `<span class="chipstat">${kinds}</span>` : ""}</div>
<h2 class="sec">Money on the books</h2>${costsTable(d)}`;
}

function snapshotDay(d, iso, notes, todayISO) {
  const l = dayLabel(iso);
  const night = d.nights[iso];
  const evs = dayEvents(d, iso)
    .map(
      (e) => `<div class="ev k-${esc(e.kind)}">
  <div class="time">${e.time ? esc(e.time) : "—"}${e.end ? `<em>${esc(e.end)}</em>` : ""}</div>
  <div class="body">${KIND_LABEL[e.kind] ? `<div class="kind">${KIND_LABEL[e.kind]}</div>` : ""}
    <p class="title">${esc(e.title)}</p>
    ${e.sub ? `<p class="sub">${esc(e.sub)}</p>` : ""}
    ${e.where ? `<p class="where">${esc(e.where)}</p>` : ""}
    ${e.notes?.length ? `<ul class="enotes">${e.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    ${e.conf ? confChip(e.conf) : ""}
  </div>
</div>`,
    )
    .join("");
  const dayNotes = notes.filter((n) => n.date === iso);
  return `<section class="day${iso === todayISO ? " today" : ""}" id="d${iso}">
  <div class="dayhead"><span class="dnum">${l.mon} ${l.day}</span><span class="dow">${l.dow}</span><span class="city">${esc(d.cities[iso] || "")}</span></div>
  <div class="card">${evs || '<div class="ev k-note"><div class="time">—</div><div class="body"><p class="title">Nothing scheduled</p></div></div>'}
    ${night ? `<div class="night"><div class="lab">Night</div><div><b>${esc(night.name)}</b>${night.sub ? ` · ${esc(night.sub)}` : ""}</div></div>` : ""}
    ${dayNotes.length ? `<div class="snotes">${dayNotes.map((n) => `<p>✎ ${esc(n.text)}</p>`).join("")}</div>` : ""}
  </div>
</section>`;
}

export function renderSnapshotBody(d, notes, todayISO) {
  return `${tripDates(d).map((iso) => snapshotDay(d, iso, notes, todayISO)).join("")}
<section class="codes ref"><h2>All confirmations</h2>${codesTable(d)}</section>
<section class="ref"><h2>Money on the books</h2>${costsTable(d)}</section>`;
}
