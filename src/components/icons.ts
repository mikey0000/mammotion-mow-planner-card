import { svg, type SVGTemplateResult } from "lit";
import type { Pattern } from "../model";

const stroked = (shape: SVGTemplateResult) =>
  svg`<g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${shape}</g>`;

export const mdiIcon = (path: string) => svg`<path d=${path}></path>`;

export const patternIcons: Readonly<Record<Pattern, SVGTemplateResult>> = {
  single_grid: stroked(
    svg`<path d="M3 4.5h15.5a2.5 2.5 0 0 1 0 5H5.5a2.5 2.5 0 0 0 0 5h13a2.5 2.5 0 0 1 0 5H3" />`,
  ),
  double_grid: stroked(
    svg`<rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" />`,
  ),
  segment_grid: stroked(
    svg`<rect x="3" y="3" width="18" height="18" rx="3" /><path d="M12 3v18M3 9h9M3 15h9M12 10l7-7M12 17l9-9M16 21l5-5" />`,
  ),
  no_grid: stroked(
    svg`<rect x="3" y="3" width="18" height="18" rx="4" /><rect x="7.5" y="7.5" width="9" height="9" rx="2" />`,
  ),
};
