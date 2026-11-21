import { defineOnce } from "../define";
import { css, html, LitElement, nothing, svg } from "lit";
import { property } from "lit/decorators.js";
import { foldAngle, foldCrossAngle } from "../geo/angles";
import { RAD } from "../geo/shared";
import type { Range } from "../model";
import { controlStyles } from "../styles";

export type DialHand = "angle" | "crossAngle";

const RADIUS = 48;
/** At the default 136 px size the 120-unit dial draws 1.13 px per unit, so this is a 44 px touch target. */
const HIT_RADIUS = 20;
const TICK_DEG = 15;
/** Degrees either side of a tick within which a dragged hand settles on it. */
const CATCH_DEG = 3;
const KEY_TURNS: Partial<Record<string, number>> = {
  ArrowLeft: 1,
  ArrowUp: 1,
  ArrowRight: -1,
  ArrowDown: -1,
};

const polar = (deg: number, r = RADIUS) => ({ x: r * Math.cos(deg * RAD), y: -r * Math.sin(deg * RAD) });

const ticks = svg`<g class="ticks">${Array.from({ length: 360 / TICK_DEG }, (_, i) => {
  const deg = i * TICK_DEG;
  const [outer, inner] = [polar(deg), polar(deg, RADIUS - (deg % 90 ? 4 : 8))];
  return svg`<line class=${deg % 90 ? "" : "major"} x1=${outer.x} y1=${outer.y} x2=${inner.x} y2=${inner.y}></line>`;
})}</g>`;

const catchTick = (deg: number) => {
  const tick = Math.round(deg / TICK_DEG) * TICK_DEG;
  return Math.abs(deg - tick) <= CATCH_DEG ? tick : Math.round(deg);
};

const clamp = (value: number, { min, max }: Range) => Math.min(Math.max(value, min), max);

/**
 * Clock dial with a hand for the path angle and, when `crossAngle` is set, a second one for the crossing
 * angle, which turns with the first. Hands point along the map direction `base + angle`; fires
 * `value-changed` with `{ hand, value }` and leaves the values to the owner.
 */
export class AngleDial extends LitElement {
  @property({ type: Number }) angle = 0;
  @property({ attribute: false }) crossAngle?: number;
  /** Map direction, in degrees counter-clockwise from east, that an angle of 0 points along. */
  @property({ type: Number }) base = 0;
  /** Draws the direction an angle of 0 stands for, for angles relative to one the mower picks. */
  @property({ type: Boolean }) reference = false;
  @property({ attribute: false }) angleRange: Range = { min: -90, max: 90, step: 1 };
  @property({ attribute: false }) crossRange: Range = { min: 1, max: 179, step: 1 };
  @property() angleLabel = "";
  @property() crossLabel = "";
  @property({ attribute: false }) format: (value: number) => string = String;
  @property({ type: Boolean, reflect: true }) disabled = false;

  private dragging?: DialHand;

  static override styles = [
    controlStyles,
    css`
      :host {
        display: block;
        inline-size: var(--mmp-dial-size, 136px);
        flex: none;
        --mmp-cross-color: var(--orange-color, #ff9800);
      }
      svg {
        display: block;
        inline-size: 100%;
        block-size: auto;
        overflow: visible;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }
      .plate {
        fill: var(--mmp-surface);
        stroke: var(--divider-color, rgba(0, 0, 0, 0.12));
      }
      .ticks line,
      .reference {
        stroke: var(--secondary-text-color, #727272);
        stroke-width: 1;
        stroke-linecap: round;
      }
      .ticks .major {
        stroke-width: 2;
      }
      .reference {
        stroke-dasharray: 3 3;
        opacity: 0.8;
      }
      .hand line {
        stroke: var(--hand-color);
        stroke-width: 2.5;
        stroke-linecap: round;
      }
      .hand .tail {
        stroke-dasharray: 1.5 4;
      }
      .hand {
        --hand-color: var(--mmp-accent);
      }
      .hand.cross {
        --hand-color: var(--mmp-cross-color);
      }
      :host([disabled]) .hand {
        --hand-color: var(--disabled-text-color, #9e9e9e);
      }
      .knob {
        cursor: grab;
        outline: none;
      }
      .knob:active {
        cursor: grabbing;
      }
      :host([disabled]) .knob {
        cursor: default;
      }
      .knob:focus-visible {
        outline: none;
      }
      .knob .hit {
        fill: transparent;
      }
      .knob .dot {
        fill: var(--hand-color);
        stroke: var(--card-background-color, #fff);
        stroke-width: 2;
      }
      .knob .ring {
        fill: none;
        stroke-width: 2;
      }
      .knob:focus-visible .ring {
        stroke: var(--hand-color);
      }
      .hub {
        fill: var(--card-background-color, #fff);
        stroke: var(--secondary-text-color, #727272);
      }
    `,
  ];

  protected override render() {
    const { angle, crossAngle, base } = this;
    const reference = polar(base);
    return html`<svg
      viewBox="-60 -60 120 120"
      @pointermove=${this.onPointerMove}
      @pointerup=${this.onPointerUp}
    >
      <circle class="plate" r=${RADIUS}></circle>
      ${ticks}
      ${
        this.reference
          ? svg`<line class="reference" x1=${-reference.x} y1=${-reference.y} x2=${reference.x} y2=${reference.y}></line>`
          : nothing
      }
      ${crossAngle === undefined ? nothing : this.renderHand("crossAngle", base + angle + crossAngle, crossAngle)}
      ${this.renderHand("angle", base + angle, angle)}
      <circle class="hub" r="3"></circle>
    </svg>`;
  }

  private renderHand(hand: DialHand, deg: number, value: number) {
    const [tip, tail] = [polar(deg), polar(deg + 180, RADIUS - 6)];
    const range = hand === "angle" ? this.angleRange : this.crossRange;
    return svg`<g class="hand ${hand === "angle" ? "" : "cross"}">
      <line class="tail" x2=${tail.x} y2=${tail.y}></line>
      <line x2=${tip.x} y2=${tip.y}></line>
      <g
        class="knob"
        role="slider"
        tabindex=${this.disabled ? -1 : 0}
        aria-label=${hand === "angle" ? this.angleLabel : this.crossLabel}
        aria-valuemin=${range.min}
        aria-valuemax=${range.max}
        aria-valuenow=${value}
        aria-valuetext=${this.format(value)}
        aria-disabled=${this.disabled ? "true" : "false"}
        transform="translate(${tip.x} ${tip.y})"
        @pointerdown=${(event: PointerEvent) => {
          this.grab(hand, event);
        }}
        @keydown=${(event: KeyboardEvent) => {
          this.onKey(hand, event);
        }}
      >
        <circle class="hit" r=${HIT_RADIUS}></circle>
        <circle class="ring" r="11"></circle>
        <circle class="dot" r="7"></circle>
      </g>
    </g>`;
  }

  private grab(hand: DialHand, event: PointerEvent) {
    if (this.disabled) return;
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    (event.currentTarget as SVGGElement).focus({ preventScroll: true });
    this.dragging = hand;
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.dragging || this.disabled) return;
    const box = this.renderRoot.querySelector("svg")?.getBoundingClientRect();
    if (!box) return;
    const deg =
      Math.atan2(box.top + box.height / 2 - event.clientY, event.clientX - box.left - box.width / 2) / RAD;
    this.turnTo(
      this.dragging,
      this.dragging === "angle"
        ? catchTick(foldAngle(deg - this.base))
        : catchTick(foldCrossAngle(deg - this.base - this.angle)),
    );
  };

  private readonly onPointerUp = () => {
    this.dragging = undefined;
  };

  private onKey(hand: DialHand, event: KeyboardEvent) {
    const turn = KEY_TURNS[event.key];
    if (!turn || this.disabled) return;
    event.preventDefault();
    const step = turn * (event.shiftKey ? TICK_DEG : 1);
    // Paths are lines, so the path angle wraps around; the crossing angle stops at its ends.
    this.turnTo(hand, hand === "angle" ? foldAngle(this.angle + step) : (this.crossAngle ?? 0) + step);
  }

  private turnTo(hand: DialHand, deg: number) {
    const value = clamp(deg, hand === "angle" ? this.angleRange : this.crossRange);
    if (value === (hand === "angle" ? this.angle : this.crossAngle)) return;
    this.dispatchEvent(new CustomEvent("value-changed", { detail: { hand, value } }));
  }
}

defineOnce("mow-planner-dial", AngleDial);

declare global {
  interface HTMLElementTagNameMap {
    "mow-planner-dial": AngleDial;
  }
}
