import type { GlossSettings, GlossType } from "./types";

/** RGB channels avoid color-mix(), which older Obsidian Chromium builds lack. */
export function colorChannels(color: string): string {
  let hex = color.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(hex)) hex = hex.split("").map(c => c + c).join("");
  if (!/^[\da-f]{6}$/i.test(hex)) hex = "8a8f98";
  return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(", ");
}

export function applyCardStyle(el: HTMLElement, settings: GlossSettings, type: GlossType): void {
  el.dataset.glossType = type.id;
  el.style.setProperty("--gloss-color", type.color);
  el.style.setProperty("--gloss-tint-rgb", colorChannels(type.color));
  el.classList.toggle("gloss-glass", settings.cardStyle === "glass");
  if (!el.querySelector(":scope > .gloss-glass-flow")) {
    el.createDiv({ cls: "gloss-glass-flow", attr: { "aria-hidden": "true" } });
  }
  // Stable stagger: rerenders retain the card's phase; no timers or animation loop.
  let seed = 0;
  for (const c of el.dataset.glossId ?? type.id) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  el.style.setProperty("--gloss-flow-duration", `${38 + seed % 11}s`);
  el.style.setProperty("--gloss-flow-delay", `-${seed % 37}s`);
}
