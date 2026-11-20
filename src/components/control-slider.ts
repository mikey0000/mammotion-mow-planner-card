import { mdiMinus, mdiPlus } from "@mdi/js";
import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { localize } from "../localize";
import type { Range } from "../model";
import { controlStyles } from "../styles";
import { mdiIcon } from "./icons";

const decimals = (step: number) => step.toString().split(".")[1]?.length ?? 0;

const snap = (value: number, { min, max, step }: Range) =>
  Number(Math.min(max, Math.max(min, min + Math.round((value - min) / step) * step)).toFixed(decimals(step)));

/** Labelled range with − / + steppers; fires `value-changed` with `{ value }` and leaves `value` to the owner. */
@customElement("mmp-slider")
export class SliderControl extends LitElement {
  @property() label = "";
  @property({ type: Number }) value = 0;
  @property({ attribute: false }) range: Range = { min: 0, max: 100, step: 1 };
  @property({ attribute: false }) format: (value: number) => string = String;
  @property() language?: string;
  @property({ type: Boolean }) disabled = false;

  static override styles = [
    controlStyles,
    css`
      :host {
        display: block;
      }
      .head {
        display: flex;
        justify-content: space-between;
        gap: var(--ha-space-2, 8px);
      }
      .value {
        font-weight: var(--ha-font-weight-medium, 500);
        white-space: nowrap;
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
      }
      input:disabled {
        cursor: default;
      }
      input::-webkit-slider-runnable-track {
        height: 8px;
        border-radius: 4px;
        background: var(--mmp-tint);
      }
      input::-moz-range-track {
        height: 8px;
        border-radius: 4px;
        background: var(--mmp-tint);
      }
      input::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 22px;
        height: 22px;
        margin-top: -7px;
        border: none;
        border-radius: 50%;
        background: var(--mmp-accent);
      }
      input::-moz-range-thumb {
        width: 22px;
        height: 22px;
        border: none;
        border-radius: 50%;
        background: var(--mmp-accent);
      }
      input:disabled::-webkit-slider-thumb {
        background: var(--disabled-text-color, #9e9e9e);
      }
      input:disabled::-moz-range-thumb {
        background: var(--disabled-text-color, #9e9e9e);
      }
    `,
  ];

  protected override render() {
    const { min, max, step } = this.range;
    const name = { name: this.label };
    return html`<div class="head">
        <label class="secondary" for="range">${this.label}</label>
        <span class="value">${this.format(this.value)}</span>
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

declare global {
  interface HTMLElementTagNameMap {
    "mmp-slider": SliderControl;
  }
}
