import { defineOnce } from "../define";
import Panzoom, { type PanzoomEventDetail, type PanzoomObject } from "@panzoom/panzoom";
import { mdiFitToScreenOutline, mdiFlash, mdiMinus, mdiPlus } from "@mdi/js";
import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import type { AreaPreview, MapModel, Marker, Point, Zone } from "../model";
import { controlStyles } from "../styles";
import { labelPosition } from "../geo/label";
import {
  clearOf,
  fitView,
  mapKey,
  polylinePath,
  previewShape,
  ringPath,
  ringWidth,
  passesPerBand,
  toScreen,
  type Insets,
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
  /** Shown while one pass is too thin to see and each mown band stands for `n` passes. */
  readonly passesPerBand: (n: number) => string;
}

interface AreaShape {
  readonly zone: Zone;
  readonly d: string;
  readonly label: Point;
  readonly widthM: number;
}

interface ClientPoint {
  readonly clientX: number;
  readonly clientY: number;
}

const TAP_SLOP_PX = 6;
const ZOOM_STEP = 0.3;
const WHEEL_ZOOM_PER_PX = 0.002;
const WHEEL_LINE_PX = 33;
const PAN_STEP_PX = 48;
const MIN_LABEL_WIDTH_PX = 48;
const MOWER_CLEARANCE_PX = 24;
const PAN_KEYS: Partial<Record<string, readonly [number, number]>> = {
  ArrowLeft: [PAN_STEP_PX, 0],
  ArrowRight: [-PAN_STEP_PX, 0],
  ArrowUp: [0, PAN_STEP_PX],
  ArrowDown: [0, -PAN_STEP_PX],
};

export class MowMap extends LitElement {
  @property({ attribute: false }) model?: MapModel;
  @property({ attribute: false }) selected: readonly number[] = [];
  @property({ attribute: false }) previews: readonly AreaPreview[] = [];
  @property({ attribute: false }) mower?: Marker;
  @property({ attribute: false }) route?: readonly (readonly Point[])[];
  /** Nothing is rendered until these are set. */
  @property({ attribute: false }) strings?: MapStrings;
  /** An extra line for the map caption. */
  @property({ attribute: false }) note?: string;
  @property({ type: Boolean, reflect: true }) readonly = false;

  @state() private view: View = { x: 0, y: 0, scale: 1 };
  @query(".viewport") private readonly viewport?: SVGGElement;
  @query(".controls") private readonly controls?: HTMLElement;
  @query(".caption") private readonly caption?: HTMLElement;

  private areaShapes: readonly AreaShape[] = [];
  private previewShapes: readonly PreviewShape[] = [];
  private routePath = "";
  private panzoom?: { readonly target: SVGGElement; readonly instance: PanzoomObject };
  private fittedMapKey?: string;
  private userAdjustedView = false;
  private gestureStart: Point = { x: 0, y: 0 };
  private dragged = false;
  private readonly touches = new Map<number, PointerEvent>();
  private pinch?: { readonly centre: ClientPoint; readonly distance: number };
  private observedCaption?: Element;
  private readonly resizeObserver = new ResizeObserver(() => {
    if (!this.userAdjustedView) this.fit();
  });

  override connectedCallback(): void {
    super.connectedCallback();
    this.resizeObserver.observe(this);
    document.addEventListener("pointermove", this.onPointerMove);
    document.addEventListener("pointerup", this.onPointerEnd);
    document.addEventListener("pointercancel", this.onPointerEnd);
    if (this.hasUpdated) this.attachPanzoom();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver.disconnect();
    document.removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("pointerup", this.onPointerEnd);
    document.removeEventListener("pointercancel", this.onPointerEnd);
    this.touches.clear();
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
        const step = passesPerBand(preview.pitchM, this.view.scale);
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
    const { model, strings } = this;
    if (!model || !strings) return nothing;
    const order = new Map(this.selected.map((hash, i) => [hash, i + 1]));
    const clipIndex = new Map(this.areaShapes.map(({ zone }, i) => [zone.hash, i]));
    const previews = this.routePath
      ? []
      : this.previewShapes.flatMap((shape) => {
          const clip = clipIndex.get(shape.hash);
          return clip === undefined ? [] : [{ shape, clip }];
        });
    const thinning = Math.max(
      1,
      ...previews
        .filter(({ shape }) => shape.stripes || shape.crossingStripes)
        .map(({ shape }) => shape.step),
    );
    const notes = [thinning > 1 ? strings.passesPerBand(thinning) : "", this.note ?? ""].filter(Boolean);
    const mower = this.mower && toScreen(this.view, this.mower.position);
    return html`
      <svg
        role="group"
        aria-label=${strings.mapLabel}
        tabindex="0"
        @pointerdown=${this.onPointerDown}
        @touchmove=${this.twoFingerScrollBlocker}
        @wheel=${this.onWheel}
        @keydown=${this.onMapKey}
      >
        <g class="viewport" @panzoomchange=${this.onViewChange}>
          <defs>
            ${this.areaShapes.map(({ d }, i) => svg`<clipPath id="clip-${i}"><path d=${d} /></clipPath>`)}
            ${previews.map(
              ({ shape }, i) =>
                svg`<clipPath id="band-${i}"><path clip-rule="evenodd" d=${shape.region} /></clipPath>`,
            )}
          </defs>
          <path class="channels" d=${model.channels.map(polylinePath).join("")} />
          ${this.areaShapes.map(({ zone, d }) => this.renderArea(strings, zone, d, order.get(zone.hash)))}
          ${this.routePath ? nothing : previews.map(({ shape }, i) => this.renderBands(shape, i))}
          ${model.obstacles.map(
            (zone) =>
              svg`<path class="nogo" role="img" aria-label="${strings.noGoZone}: ${zone.name}" d=${ringPath(zone.outline)} />`,
          )}
          ${
            this.routePath
              ? svg`<path class="route" d=${this.routePath} />`
              : previews.map(({ shape, clip }) => this.renderLaps(shape, clip))
          }
        </g>
        <g class="overlay">
          ${this.areaShapes.map((shape) => this.renderLabel(shape, order.get(shape.zone.hash), mower))}
          ${model.dock && this.renderDock(strings, model.dock)}
          ${this.mower && this.renderMower(strings, this.mower)}
        </g>
      </svg>
      <div class="caption" role="note" ?hidden=${!notes.length} ${ref(this.observeCaption)}>
        ${notes.map((line) => html`<div>${line}</div>`)}
      </div>
      <div class="controls">
        ${this.renderButton(strings.zoomIn, mdiPlus, this.zoomIn)}
        ${this.renderButton(strings.zoomOut, mdiMinus, this.zoomOut)}
        ${this.renderButton(strings.fit, mdiFitToScreenOutline, this.fit)}
      </div>
    `;
  }

  private renderArea(strings: MapStrings, zone: Zone, d: string, order: number | undefined) {
    const label = strings.area({ name: zone.name, areaM2: zone.areaM2, order });
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

  /** Mown bands below the no-go zones, trimmed to the mown region; two passes overlap into a check. */
  private renderBands(shape: PreviewShape, index: number) {
    const width = `stroke-width: ${shape.bandWidthM}px`;
    return svg`<g class="preview" clip-path="url(#band-${index})">
      <path class="stripes" style=${width} d=${shape.stripes} />
      ${shape.crossingStripes ? svg`<path class="stripes crossing" style=${width} d=${shape.crossingStripes} />` : nothing}
    </g>`;
  }

  /** Laps on top of everything, so they stay readable over the bands. */
  private renderLaps(shape: PreviewShape, clip: number) {
    return svg`<path class="laps" clip-path="url(#clip-${clip})" d=${`${shape.laps}${shape.obstacleLaps}`} />`;
  }

  private renderLabel({ zone, label, widthM }: AreaShape, order: number | undefined, mower?: Point) {
    const at = toScreen(this.view, label);
    const { x, y } = mower ? clearOf(at, mower, MOWER_CLEARANCE_PX) : at;
    const showName = widthM * this.view.scale >= MIN_LABEL_WIDTH_PX;
    const badgeY = showName ? -12 : 0;
    return svg`<g class="label" aria-hidden="true" transform="translate(${x} ${y})">
      ${showName ? svg`<text class="name" y=${order ? 9 : 0}>${zone.name}</text>` : nothing}
      ${order ? svg`<circle class="badge-bg" cy=${badgeY} r="10" /><text class="badge" y=${badgeY}>${order}</text>` : nothing}
    </g>`;
  }

  private renderDock(strings: MapStrings, { position }: Marker) {
    const { x, y } = toScreen(this.view, position);
    return svg`<g class="dock" role="img" aria-label=${strings.dock} transform="translate(${x} ${y})">
      <rect x="-12" y="-12" width="24" height="24" rx="6" />
      <path d=${mdiFlash} transform="translate(-9 -9) scale(0.75)" />
    </g>`;
  }

  private renderMower(strings: MapStrings, { position, headingDeg }: Marker) {
    const { x, y } = toScreen(this.view, position);
    return svg`<g class="mower" role="img" aria-label=${strings.mower} transform="translate(${x} ${y}) rotate(${headingDeg ?? 0})">
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
      // Unbound: a lone touch is left to scroll the page, so pointers are forwarded selectively.
      instance: Panzoom(target, {
        noBind: true,
        canvas: true,
        cursor: "grab",
        touchAction: "pan-x pan-y",
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
    const view = fitView(this.model.bounds, this.clientWidth, this.clientHeight, this.covered());
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

  /** How far the zoom buttons and the caption reach into the map. */
  private covered(): Insets {
    const host = this.getBoundingClientRect();
    const controls = this.controls?.getBoundingClientRect();
    const caption = this.caption?.hidden === false ? this.caption.getBoundingClientRect() : undefined;
    const rtl = getComputedStyle(this).direction === "rtl";
    return {
      left: controls && rtl ? controls.right - host.left : 0,
      right: controls && !rtl ? host.right - controls.left : 0,
      bottom: caption ? host.bottom - caption.top : 0,
    };
  }

  private zoomBy(step: number): void {
    const host = this.getBoundingClientRect();
    const { left, right, bottom } = this.covered();
    this.zoomAt(Math.exp(step), {
      clientX: host.left + (left + host.width - right) / 2,
      clientY: host.top + (host.height - bottom) / 2,
    });
  }

  private zoomAt(factor: number, point: ClientPoint): void {
    const instance = this.panzoom?.instance;
    if (!instance) return;
    instance.zoomToPoint(instance.getScale() * factor, point);
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
    event.preventDefault();
    const px = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * WHEEL_LINE_PX : event.deltaY;
    this.zoomAt(Math.exp(-px * WHEEL_ZOOM_PER_PX), event);
  };

  private readonly twoFingerScrollBlocker = {
    passive: false,
    handleEvent: (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    },
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    this.dragged = !event.isPrimary;
    if (event.isPrimary) this.gestureStart = { x: event.clientX, y: event.clientY };
    if (event.pointerType !== "touch") {
      this.panzoom?.instance.handleDown(event);
      return;
    }
    this.touches.set(event.pointerId, event);
    this.restartPinch();
  };

  // A tap jitters by a pixel or two; only a real drag or pinch counts as the user moving the view.
  private readonly onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "touch") this.panzoom?.instance.handleMove(event);
    else if (this.touches.has(event.pointerId)) {
      this.touches.set(event.pointerId, event);
      this.followPinch();
    }
    const { x, y } = this.gestureStart;
    if (Math.hypot(event.clientX - x, event.clientY - y) <= TAP_SLOP_PX) return;
    this.dragged = true;
    if (event.buttons && event.pointerType !== "touch") this.userAdjustedView = true;
  };

  private readonly onPointerEnd = (event: PointerEvent) => {
    if (event.type === "pointercancel") this.dragged = true;
    if (event.pointerType !== "touch") {
      this.panzoom?.instance.handleUp(event);
      return;
    }
    this.touches.delete(event.pointerId);
    this.restartPinch();
  };

  private restartPinch(): void {
    this.pinch = undefined;
    this.followPinch();
  }

  /** Zooms by the change in distance between the first two touches and pans by the move of their midpoint. */
  private followPinch(): void {
    const [a, b] = this.touches.values();
    const instance = this.panzoom?.instance;
    if (!a || !b || !instance) return;
    const centre = { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const from = this.pinch;
    if (from?.distance) {
      instance.zoomToPoint(instance.getScale() * (distance / from.distance), from.centre);
      const scale = instance.getScale();
      const [dx, dy] = [centre.clientX - from.centre.clientX, centre.clientY - from.centre.clientY];
      instance.pan(dx / scale, dy / scale, { relative: true });
      this.userAdjustedView = true;
    }
    this.pinch = { centre, distance };
  }

  private readonly observeCaption = (caption?: Element) => {
    if (this.observedCaption) this.resizeObserver.unobserve(this.observedCaption);
    this.observedCaption = caption;
    if (caption) this.resizeObserver.observe(caption);
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
        --mmp-selected-color: color-mix(
          in srgb,
          var(--mmp-area-color) 60%,
          var(--primary-text-color, #212121)
        );
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
      .viewport :not(.area) {
        pointer-events: none;
      }
      .viewport .area {
        fill: color-mix(
          in srgb,
          color-mix(in srgb, var(--mmp-area-color) 50%, var(--mmp-channel-color)) 16%,
          transparent
        );
        stroke: color-mix(
          in srgb,
          color-mix(in srgb, var(--mmp-area-color) 40%, var(--mmp-channel-color)) 60%,
          transparent
        );
        stroke-width: 1;
        cursor: pointer;
        outline: none;
      }
      .viewport .area.selected {
        fill: color-mix(in srgb, var(--mmp-area-color) 70%, transparent);
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
        stroke: color-mix(in srgb, var(--mmp-nogo-color) 60%, var(--mmp-halo-color));
        stroke-width: 1.5;
      }
      .viewport .stripes {
        vector-effect: none;
        stroke: color-mix(in srgb, var(--mmp-selected-color) 42%, transparent);
        stroke-linecap: butt;
      }
      .viewport .laps {
        stroke: color-mix(in srgb, var(--mmp-path-color) 75%, var(--mmp-area-color));
        stroke-width: 1.5;
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
        fill: var(--mmp-halo-color);
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
      .caption {
        position: absolute;
        inset-block-end: var(--ha-space-2, 8px);
        inset-inline-start: var(--ha-space-2, 8px);
        max-inline-size: calc(100% - var(--mmp-control-height) - 4 * var(--ha-space-2, 8px));
        box-sizing: border-box;
        padding: var(--ha-space-1, 4px) var(--ha-space-2, 8px);
        border-radius: var(--ha-border-radius-md, 8px);
        background: color-mix(in srgb, var(--card-background-color, #fff) 85%, transparent);
        color: var(--secondary-text-color, #727272);
        font-size: var(--ha-font-size-s, 12px);
        line-height: 16px;
        pointer-events: none;
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

defineOnce("mow-planner-map", MowMap);
