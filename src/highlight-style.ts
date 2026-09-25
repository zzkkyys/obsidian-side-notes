/** A bounded hand-drawn silhouette: uneven ends/edges, with a fully covered central band.
 * Rendered as an inline background per line fragment, never as an absolute multi-line overlay. */
export function markerBackground(color: string): string {
  const fill = /^#[\da-f]{3}([\da-f]{3})?$/i.test(color) ? color : "#f5a524";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="40" viewBox="0 0 240 40" preserveAspectRatio="none"><path fill="${fill}" fill-opacity=".27" d="M0 3 L18 1 L43 3 L69 2 L96 4 L121 2 L146 3 L173 1 L201 3 L222 2 L240 4 L239 15 L240 26 L239 38 L217 37 L191 39 L164 37 L139 38 L111 36 L84 38 L59 37 L34 39 L12 37 L0 38 L1 25 L0 14 Z"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
