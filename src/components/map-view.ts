import Panzoom, { type PanzoomEventDetail, type PanzoomObject } from "@panzoom/panzoom";
import { mdiFitToScreenOutline, mdiFlash, mdiMinus, mdiPlus } from "@mdi/js";
import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { AreaPreview, MapModel, Marker, Point, Zone } from "../model";
import { controlStyles } from "../styles";
import { labelPosition } from "../geo/label";
import {
  fitView,
  mapKey,
  polylinePath,
  previewShape,
  ringPath,
  ringWidth,
  stripeStep,
  toScreen,
  type PreviewShape,
  type View,
} from "./map-geometry";

export interface MapStrings {
  readonly mapLabel: string;
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly fit: string;
  readonly dock: string;
  readonly mower: string;
  readonly noGoZone: string;
  /** Accessible name of an area; `order` is its 1-based mowing position when selected. */
  readonly area: (area: { name: string; areaM2: number; order?: number }) => string;
}

export const DEFAULT_MAP_STRINGS: MapStrings = {
  mapLabel: "Map",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  fit: "Fit map",
  dock: "Dock",
  mower: "Mower",
  noGoZone: "No-go zone",
  area: ({ name, areaM2, order }) =>
    `${name}, ${Math.round(areaM2)} m²${order ? `, selected, position ${order}` : ""}`,
};

interface AreaShape {
  readonly zone: Zone;
  readonly d: string;
  readonly label: Point;
  readonly widthM: number;
}

const TAP_SLOP_PX = 6;
const ZOOM_STEP = 0.3;
const PAN_STEP_PX = 48;
const MIN_LABEL_WIDTH_PX = 48;
const PAN_KEYS: Partial<Record<string, readonly [number, number]>> = {
  ArrowLeft: [PAN_STEP_PX, 0],
  ArrowRight: [-PAN_STEP_PX, 0],
  ArrowUp: [0, PAN_STEP_PX],
  ArrowDown: [0, -PAN_STEP_PX],
};

@customElement("mmp-map")
export class MowMap extends LitElement {
  @property({ attribute: false }) model?: MapModel;
  @property({ attribute: false }) selected: readonly number[] = [];
  @property({ attribute: false }) previews: readonly AreaPreview[] = [];
  @property({ attribute: false }) mower?: Marker;
  @property({ attribute: false }) route?: readonly (readonly Point[])[];
  @property({ attribute: false }) strings: MapStrings = DEFAULT_MAP_STRINGS;
  @property({ type: Boolean, reflect: true }) readonly = false;

  @state() private view: View = { x: 0, y: 0, scale: 1 };
  @query("svg") private readonly svgElement?: SVGSVGElement;
  @query(".viewport") private readonly viewport?: SVGGElement;

  private areaShapes: readonly AreaShape[] = [];
  private previewShapes: readonly PreviewShape[] = [];
  private routePath = "";
  private panzoom?: { readonly target: SVGGElement; readonly instance: PanzoomObject };
  private fittedMapKey?: string;
  private userAdjustedView = false;
  private gestureStart: Point = { x: 0, y: 0 };
  private dragged = false;
  private readonly resizeObserver = new ResizeObserver(() => {
    if (!this.userAdjustedView) this.fit();
  });

  override connectedCallback(): void {
    super.connectedCallback();
    this.resizeObserver.observe(this);
    if (this.hasUpdated) this.attachPanzoom();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver.disconnect();
    this.panzoom?.instance.destroy();
    this.panzoom = undefined;
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("model")) {
      const obstacles = (this.model?.obstacles ?? []).map((o) => o.outline);
      this.areaShapes = (this.model?.areas ?? []).map((zone) => ({
        zone,
        d: ringPath(zone.outline),
        label: labelPosition(zone.outline, obstacles),
        widthM: ringWidth(zone.outline),
      }));
    }
    if (changed.has("previews") || changed.has("view")) {
      this.previewShapes = this.previews.map((preview, i) => {
        const step = stripeStep(preview.pitchM, this.view.scale);
        const drawn = changed.has("previews") ? undefined : this.previewShapes[i];
        return drawn?.step === step ? drawn : previewShape(preview, step);
      });
    }
    if (changed.has("route")) this.routePath = (this.route ?? []).map(polylinePath).join("");
  }

  protected override updated(changed: PropertyValues<this>): void {
    this.attachPanzoom();
    if (changed.has("model") && this.model && mapKey(this.model) !== this.fittedMapKey) this.fit();
  }

  protected override render() {
    const model = this.model;
    if (!model) return nothing;
    const order = new Map(this.selected.map((hash, i) => [hash, i + 1]));
    return html`
      <svg
        role="group"
        aria-label=${this.strings.mapLabel}
        tabindex="0"
        @pointerdown=${this.onPointerDown}
        @pointermove=${this.onPointerMove}
        @wheel=${this.onWheel}
        @keydown=${this.onMapKey}
      >
        <g class="viewport" @panzoomchange=${this.onViewChange}>
          <defs>
            ${this.areaShapes.map(({ d }, i) => svg`<clipPath id="clip-${i}"><path d=${d} /></clipPath>`)}
          </defs>
          <path class="channels" d=${model.channels.map(polylinePath).join("")} />
          ${this.areaShapes.map(({ zone, d }) => this.renderArea(zone, d, order.get(zone.hash)))}
          ${model.obstacles.map(
            (zone) =>
              svg`<path class="nogo" role="img" aria-label="${this.strings.noGoZone}: ${zone.name}" d=${ringPath(zone.outline)} />`,
          )}
          ${this.routePath ? svg`<path class="route" d=${this.routePath} />` : this.renderPreviews()}
        </g>
        <g class="overlay">
          ${this.areaShapes.map((shape) => this.renderLabel(shape, order.get(shape.zone.hash)))}
          ${model.dock && this.renderDock(model.dock)} ${this.mower && this.renderMower(this.mower)}
        </g>
      </svg>
      <div class="controls">
        ${this.renderButton(this.strings.zoomIn, mdiPlus, this.zoomIn)}
        ${this.renderButton(this.strings.zoomOut, mdiMinus, this.zoomOut)}
        ${this.renderButton(this.strings.fit, mdiFitToScreenOutline, this.fit)}
      </div>
    `;
  }

  private renderArea(zone: Zone, d: string, order: number | undefined) {
    const label = this.strings.area({ name: zone.name, areaM2: zone.areaM2, order });
    return this.readonly
      ? svg`<path class="area ${order ? "selected" : ""}" data-hash=${zone.hash} role="img" aria-label=${label} d=${d} />`
      : svg`<path
          class="area ${order ? "selected" : ""}"
          data-hash=${zone.hash}
          role="checkbox"
          tabindex="0"
          aria-checked=${order ? "true" : "false"}
          aria-label=${label}
          d=${d}
          @click=${this.onAreaClick}
          @keydown=${this.onAreaKey}
        />`;
  }

  private renderPreviews() {
    const clipIndex = new Map(this.areaShapes.map(({ zone }, i) => [zone.hash, i]));
    return this.previewShapes.map((shape) => {
      const index = clipIndex.get(shape.hash);
      if (index === undefined) return nothing;
      return svg`<g class="preview" clip-path="url(#clip-${index})">
        <path class="stripes" d=${shape.stripes} />
        ${shape.crossingStripes ? svg`<path class="stripes crossing" d=${shape.crossingStripes} />` : nothing}
        <path class="laps" d=${shape.laps} />
        <path class="obstacle-laps" d=${shape.obstacleLaps} />
      </g>`;
    });
  }

  private renderLabel({ zone, label, widthM }: AreaShape, order: number | undefined) {
    const { x, y } = toScreen(this.view, label);
    const showName = widthM * this.view.scale >= MIN_LABEL_WIDTH_PX;
    const badgeY = showName ? -12 : 0;
    return svg`<g class="label" aria-hidden="true" transform="translate(${x} ${y})">
      ${showName ? svg`<text class="name" y=${order ? 9 : 0}>${zone.name}</text>` : nothing}
      ${order ? svg`<circle class="badge-bg" cy=${badgeY} r="10" /><text class="badge" y=${badgeY}>${order}</text>` : nothing}
    </g>`;
  }

  private renderDock({ position }: Marker) {
    const { x, y } = toScreen(this.view, position);
    return svg`<g class="dock" role="img" aria-label=${this.strings.dock} transform="translate(${x} ${y})">
      <rect x="-12" y="-12" width="24" height="24" rx="6" />
      <path d=${mdiFlash} transform="translate(-9 -9) scale(0.75)" />
    </g>`;
  }

  private renderMower({ position, headingDeg }: Marker) {
    const { x, y } = toScreen(this.view, position);
    return svg`<g class="mower" role="img" aria-label=${this.strings.mower} transform="translate(${x} ${y}) rotate(${headingDeg ?? 0})">
      <path d="M0 -13L10 11L0 6L-10 11Z" />
    </g>`;
  }

  private renderButton(label: string, icon: string, action: () => void) {
    return html`<button type="button" aria-label=${label} title=${label} @click=${action}>
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d=${icon} /></svg>
    </button>`;
  }

  private attachPanzoom(): void {
    const target = this.isConnected ? this.viewport : undefined;
    if (this.panzoom?.target === target) return;
    this.panzoom?.instance.destroy();
    this.panzoom = target && {
      target,
      // touch-action none: the map is a pan surface, so one-finger drags must not scroll the page.
      instance: Panzoom(target, {
        canvas: true,
        cursor: "grab",
        touchAction: "none",
        startX: this.view.x,
        startY: this.view.y,
        startScale: this.view.scale,
        minScale: 1e-3,
        maxScale: 1e4,
      }),
    };
    if (!this.userAdjustedView) this.fit();
  }

  private readonly fit = (): void => {
    const instance = this.panzoom?.instance;
    if (!instance || !this.model || !this.clientWidth || !this.clientHeight) return;
    const view = fitView(this.model.bounds, this.clientWidth, this.clientHeight);
    instance.setOptions({
      startX: view.x,
      startY: view.y,
      startScale: view.scale,
      minScale: view.scale / 4,
      maxScale: view.scale * 64,
    });
    instance.reset({ animate: false });
    this.fittedMapKey = mapKey(this.model);
    this.userAdjustedView = false;
  };

  private readonly zoomIn = () => {
    this.zoomBy(ZOOM_STEP);
  };

  private readonly zoomOut = () => {
    this.zoomBy(-ZOOM_STEP);
  };

  private zoomBy(step: number): void {
    const instance = this.panzoom?.instance;
    const box = this.svgElement?.getBoundingClientRect();
    if (!instance || !box) return;
    instance.zoomToPoint(instance.getScale() * Math.exp(step), {
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    });
    this.userAdjustedView = true;
  }

  private panBy(dx: number, dy: number): void {
    const instance = this.panzoom?.instance;
    if (!instance) return;
    instance.pan(dx / instance.getScale(), dy / instance.getScale(), { relative: true });
    this.userAdjustedView = true;
  }

  private readonly onViewChange = ({ detail }: CustomEvent<PanzoomEventDetail>) => {
    this.view = { x: detail.x, y: detail.y, scale: detail.scale };
  };

  private readonly onWheel = (event: WheelEvent) => {
    this.panzoom?.instance.zoomWithWheel(event);
    this.userAdjustedView = true;
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    this.dragged = !event.isPrimary;
    if (event.isPrimary) this.gestureStart = { x: event.clientX, y: event.clientY };
  };

  // A tap jitters by a pixel or two; only a real drag or pinch counts as the user moving the view.
  private readonly onPointerMove = (event: PointerEvent) => {
    const { x, y } = this.gestureStart;
    if (Math.hypot(event.clientX - x, event.clientY - y) <= TAP_SLOP_PX) return;
    this.dragged = true;
    if (event.buttons) this.userAdjustedView = true;
  };

  private readonly onMapKey = (event: KeyboardEvent) => {
    const pan = PAN_KEYS[event.key];
    if (pan) this.panBy(...pan);
    else if (event.key === "+" || event.key === "=") this.zoomBy(ZOOM_STEP);
    else if (event.key === "-") this.zoomBy(-ZOOM_STEP);
    else return;
    event.preventDefault();
  };

  private readonly onAreaClick = (event: MouseEvent) => {
    if (!this.dragged) this.toggle(event);
  };

  private readonly onAreaKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    this.toggle(event);
  };

  private toggle(event: Event): void {
    const hash = Number((event.currentTarget as SVGElement).dataset.hash);
    this.dispatchEvent(new CustomEvent("area-toggle", { detail: { hash }, bubbles: true, composed: true }));
  }

  static override styles = [
    controlStyles,
    css`
      :host {
        --mmp-area-color: var(--success-color, #43a047);
        --mmp-selected-color: var(--primary-color, #03a9f4);
        --mmp-nogo-color: var(--warning-color, #ffa600);
        --mmp-channel-color: var(--secondary-text-color, #727272);
        --mmp-path-color: var(--primary-text-color, #212121);
        --mmp-route-color: var(--primary-color, #03a9f4);
        --mmp-mower-color: var(--primary-color, #03a9f4);
        --mmp-halo-color: var(--card-background-color, #fff);
        display: block;
        position: relative;
        min-height: 200px;
        overflow: hidden;
      }
      svg:not(.icon) {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: block;
      }
      svg:focus-visible {
        outline-offset: -2px;
      }
      .viewport path {
        vector-effect: non-scaling-stroke;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .viewport .channels {
        stroke: var(--mmp-channel-color);
        stroke-opacity: 0.7;
        stroke-width: 1.5;
        stroke-dasharray: 4 4;
      }
      .viewport .area {
        fill: color-mix(in srgb, var(--mmp-area-color) 28%, transparent);
        stroke: color-mix(in srgb, var(--mmp-area-color) 75%, transparent);
        stroke-width: 1.5;
        cursor: pointer;
        outline: none;
      }
      .viewport .area.selected {
        fill: color-mix(in srgb, var(--mmp-area-color) 50%, transparent);
        stroke: var(--mmp-selected-color);
        stroke-width: 3;
      }
      .viewport .area:focus-visible {
        stroke: var(--mmp-path-color);
        stroke-width: 3;
        stroke-dasharray: 6 3;
      }
      :host([readonly]) .viewport .area {
        cursor: inherit;
      }
      .viewport .nogo {
        fill: color-mix(in srgb, var(--mmp-nogo-color) 35%, transparent);
        stroke: var(--mmp-nogo-color);
        stroke-width: 1.5;
      }
      .viewport .stripes {
        stroke: color-mix(in srgb, var(--mmp-path-color) 45%, var(--mmp-area-color));
        stroke-width: 1;
      }
      .viewport .stripes.crossing {
        stroke: color-mix(in srgb, var(--mmp-path-color) 28%, var(--mmp-area-color));
      }
      .viewport .laps {
        stroke: color-mix(in srgb, var(--mmp-path-color) 75%, var(--mmp-area-color));
        stroke-width: 1.5;
      }
      .viewport .obstacle-laps {
        stroke: var(--mmp-nogo-color);
        stroke-width: 1.25;
      }
      .viewport .route {
        stroke: var(--mmp-route-color);
        stroke-width: 1.5;
      }
      .overlay {
        pointer-events: none;
      }
      .overlay text {
        font-size: var(--ha-font-size-s, 12px);
        font-weight: var(--ha-font-weight-medium, 500);
        fill: var(--primary-text-color, #212121);
        stroke: var(--mmp-halo-color);
        stroke-width: 3px;
        stroke-linejoin: round;
        paint-order: stroke;
        text-anchor: middle;
        dominant-baseline: central;
      }
      .overlay .badge-bg {
        fill: var(--mmp-selected-color);
      }
      .overlay .badge {
        fill: var(--text-primary-color, #fff);
        stroke: none;
      }
      .dock rect {
        fill: var(--mmp-halo-color);
        stroke: var(--secondary-text-color, #727272);
        stroke-width: 1.5;
      }
      .dock path {
        fill: var(--primary-text-color, #212121);
      }
      .mower path {
        fill: var(--mmp-mower-color);
        stroke: var(--mmp-halo-color);
        stroke-width: 2;
        stroke-linejoin: round;
      }
      .controls {
        position: absolute;
        inset-block-start: var(--ha-space-2, 8px);
        inset-inline-end: var(--ha-space-2, 8px);
        display: flex;
        flex-direction: column;
        border-radius: var(--mmp-radius);
        background: color-mix(in srgb, var(--card-background-color, #fff) 85%, transparent);
        box-shadow: 0 1px 3px color-mix(in srgb, #000 25%, transparent);
      }
      .controls button {
        display: grid;
        place-items: center;
        width: var(--mmp-control-height);
        height: var(--mmp-control-height);
        border-radius: var(--mmp-radius);
      }
      .controls button:hover {
        background: var(--mmp-surface);
      }
    `,
  ];
}
