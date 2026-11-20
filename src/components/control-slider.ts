import { defineOnce } from "../define";
import { mdiMinus, mdiPlus } from "@mdi/js";
import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { styleMap } from "lit/directives/style-map.js";
import { localize } from "../localize";
import type { Range } from "../model";
import { controlStyles } from "../styles";
import { headStyles } from "./control-head";
import { mdiIcon } from "./icons";

const decimals = (step: number) => step.toString().split(".")[1]?.length ?? 0;

const snap = (value: number, { min, max, step }: Range) =>
  Number(Math.min(max, Math.max(min, min + Math.round((value - min) / step) * step)).toFixed(decimals(step)));

/** Labelled range with − / + steppers, its track filled from `origin` (default: the minimum) to the value; fires `value-changed` with `{ value }` and leaves `value` to the owner. */
export class SliderControl extends LitElement {
  @property() label = "";
  @property({ type: Number }) value = 0;
  @property({ type: Number }) origin?: number;
  @property({ attribute: false }) range: Range = { min: 0, max: 100, step: 1 };
  @property({ attribute: false }) format: (value: number) => string = String;
  @property() language?: string;
  @property({ type: Boolean }) disabled = false;

  static override styles = [
    controlStyles,
    headStyles,
    css`
      :host {
        display: block;
      }
      .row {
        display: flex;
        align-items: center;
        gap: var(--ha-space-1, 4px);
        height: var(--mmp-control-height);
      }
      .row button {
        display: grid;
        place-items: center;
        width: var(--mmp-control-height);
        height: var(--mmp-control-height);
        border-radius: var(--mmp-radius);
        background: var(--mmp-surface);
        flex: none;
      }
      input {
        flex: 1;
        min-width: 0;
        height: var(--mmp-control-height);
        margin: 0;
        background: none;
        appearance: none;
        -webkit-appearance: none;
        cursor: pointer;
        --mmp-thumb: 28px;
        --mmp-fill: var(--mmp-accent);
        --mmp-fill-dir: to right;
        --mmp-from: calc(var(--mmp-thumb) / 2 + var(--mmp-fill-from) * (100% - var(--mmp-thumb)));
        --mmp-to: calc(var(--mmp-thumb) / 2 + var(--mmp-fill-to) * (100% - var(--mmp-thumb)));
        --mmp-track: linear-gradient(
          var(--mmp-fill-dir),
          var(--mmp-tint) var(--mmp-from),
          var(--mmp-fill) var(--mmp-from) var(--mmp-to),
          var(--mmp-tint) var(--mmp-to)
        );
      }
      input:dir(rtl) {
        --mmp-fill-dir: to left;
      }
      input:disabled {
        cursor: default;
        --mmp-fill: var(--disabled-text-color, #9e9e9e);
      }
      input::-webkit-slider-runnable-track {
        height: 8px;
        border-radius: 4px;
        background: var(--mmp-track);
      }
      input::-moz-range-track {
        height: 8px;
        border-radius: 4px;
        background: var(--mmp-track);
      }
      input::-webkit-slider-thumb {
        -webkit-appearance: none;
        box-sizing: border-box;
        width: var(--mmp-thumb);
        height: var(--mmp-thumb);
        margin-top: calc(4px - var(--mmp-thumb) / 2);
        border: 3px solid transparent;
        border-radius: 50%;
        background: var(--mmp-fill) padding-box;
      }
      input::-moz-range-thumb {
        box-sizing: border-box;
        width: var(--mmp-thumb);
        height: var(--mmp-thumb);
        border: 3px solid transparent;
        border-radius: 50%;
        background: var(--mmp-fill) padding-box;
      }
    `,
  ];

  protected override render() {
    const { min, max, step } = this.range;
    const name = { name: this.label };
    const position = (value: number) => (Math.min(max, Math.max(min, value)) - min) / (max - min || 1);
    const ends = [position(this.origin ?? min), position(this.value)];
    return html`<div class="head">
        <label class="secondary" for="range">${this.label}</label>
        <span class="value" aria-hidden="true">${this.format(this.value)}</span>
      </div>
      <div class="row">
        <button
          aria-label=${localize(this.language, "action.decrease", name)}
          ?disabled=${this.disabled || this.value <= min}
          @click=${() => {
            this.change(this.value - step);
          }}
        >
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${mdiIcon(mdiMinus)}</svg>
        </button>
        <input
          id="range"
          type="range"
          min=${min}
          max=${max}
          step=${step}
          aria-valuetext=${this.format(this.value)}
          style=${styleMap({
            "--mmp-fill-from": String(Math.min(...ends)),
            "--mmp-fill-to": String(Math.max(...ends)),
          })}
          .value=${live(String(this.value))}
          ?disabled=${this.disabled}
          @input=${(event: Event) => {
            this.change(Number((event.target as HTMLInputElement).value));
          }}
        />
        <button
          aria-label=${localize(this.language, "action.increase", name)}
          ?disabled=${this.disabled || this.value >= max}
          @click=${() => {
            this.change(this.value + step);
          }}
        >
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${mdiIcon(mdiPlus)}</svg>
        </button>
      </div>`;
  }

  private change(requested: number) {
    const value = snap(requested, this.range);
    if (this.disabled || value === this.value) return;
    this.dispatchEvent(new CustomEvent("value-changed", { detail: { value } }));
  }
}

defineOnce("mow-planner-slider", SliderControl);

declare global {
  interface HTMLElementTagNameMap {
    "mow-planner-slider": SliderControl;
  }
}
