// Small DOM helpers shared by app.js and edit.js. No native alert/confirm.
import { esc } from "./model.js";

export const $ = (sel, root = document) => root.querySelector(sel);

let toastTimer;
export function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

// Opens the shared bottom sheet with the given inner HTML; returns its body.
export function openSheet(html) {
  const dlg = $("#sheet");
  dlg.innerHTML = `<div class="sheetbody"><div class="grab"></div>${html}</div>`;
  if (!dlg.open) dlg.showModal();
  return dlg.firstElementChild;
}

export const closeSheet = () => $("#sheet").open && $("#sheet").close();

// Resolves to the label of the chosen button, or null if dismissed.
export function choose(message, buttons) {
  const dlg = $("#confirm");
  dlg.innerHTML = `<div class="sheetbody"><p>${message}</p><div class="btnrow">${buttons
    .map(
      (b, i) =>
        `<button type="button" class="btn${b.cls ? ` ${b.cls}` : ""}" data-i="${i}">${esc(b.label)}</button>`,
    )
    .join("")}</div></div>`;
  return new Promise((resolve) => {
    let picked = null;
    dlg.onclick = (e) => {
      const b = e.target.closest("[data-i]");
      if (b) {
        picked = buttons[Number(b.dataset.i)].label;
        dlg.close();
      } else if (e.target === dlg) dlg.close();
    };
    dlg.onclose = () => resolve(picked);
    dlg.showModal();
  });
}

export const confirmDialog = async (message, okLabel, cls = "primary") =>
  (await choose(message, [
    { label: "Cancel" },
    { label: okLabel, cls },
  ])) === okLabel;

export function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Couldn't copy");
  }
}
