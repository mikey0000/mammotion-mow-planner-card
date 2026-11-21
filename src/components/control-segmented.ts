import { defineOnce } from "../define";
import { css, html, LitElement, type SVGTemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { controlStyles } from "../styles";
import { headStyles } from "./control-head";

export type SegmentValue = string | number | boolean;

export interface SegmentOption<T extends SegmentValue = SegmentValue> {
  readonly value: T;
  readonly label: string;
  readonly icon?: SVGTemplateResult;
}

const steps: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Labelled single-choice control showing the selection as text; fires `value-changed` with `{ value }` and leaves `value` to the owner. */
export class SegmentedControl extends LitElement {
  @property() label = "";
  @property({ attribute: false }) options: readonly SegmentOption[] = [];
  @property({ attribute: false }) value?: SegmentValue;
  @property({ type: Boolean, reflect: true }) disabled = false;

  static override styles = [
    controlStyles,
    headStyles,
    css`
      :host {
        display: block;
        container-type: inline-size;
      }
      .group {
        display: grid;
        grid-auto-flow: column;
        /* Equal segments, except one whose longest word would not fit grows to it. */
        grid-auto-columns: minmax(min-content, 1fr);
        border-radius: var(--mmp-radius);
        background: var(--mmp-surface);
      }
      button {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--ha-space-1, 4px);
        min-width: var(--mmp-control-height);
        height: var(--mmp-control-height);
        padding-inline: var(--ha-space-2, 8px);
        border-radius: var(--mmp-radius);
        font-weight: var(--ha-font-weight-medium, 500);
        transition: background-color 120ms;
      }
      button[aria-checked="true"] {
        background: var(--mmp-tint);
        color: var(--primary-text-color, #212121);
      }
      button[aria-checked="true"]:disabled {
        background: var(--mmp-surface);
        color: var(--disabled-text-color, #9e9e9e);
      }
      /* A long label takes a second line rather than being cut short. */
      .text {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
        line-height: 1.15;
        text-align: center;
        overflow-wrap: break-word;
      }
      .icon {
        width: 20px;
        height: 20px;
      }
      @container (max-width: 360px) {
        .icon + .text {
          display: none;
        }
      }
    `,
  ];

  protected override render() {
    const selected = this.selectedIndex;
    return html`<div class="head" aria-hidden="true">
        <span class="secondary">${this.label}</span>
        <span class="value">${this.options.find((option) => option.value === this.value)?.label}</span>
      </div>
      <div
        class="group"
        role="radiogroup"
        aria-label=${this.label}
        @keydown=${(event: KeyboardEvent) => {
          this.onKeydown(event);
        }}
      >
        ${this.options.map(
          (option, index) =>
            html`<button
              role="radio"
              aria-checked=${option.value === this.value ? "true" : "false"}
              aria-label=${option.label}
              title=${option.label}
              tabindex=${index === selected ? 0 : -1}
              ?disabled=${this.disabled}
              @click=${() => {
                this.select(option);
              }}
            >
              ${option.icon && html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${option.icon}</svg>`}
              <span class="text">${option.label}</span>
            </button>`,
        )}
      </div>`;
  }

  private select(option: SegmentOption) {
    if (this.disabled || option.value === this.value) return;
    this.dispatchEvent(new CustomEvent("value-changed", { detail: { value: option.value } }));
  }

  private onKeydown(event: KeyboardEvent) {
    const index = this.targetIndex(event.key);
    const option = index === undefined ? undefined : this.options[index];
    if (index === undefined || !option) return;
    event.preventDefault();
    this.select(option);
    this.renderRoot.querySelectorAll("button")[index]?.focus();
  }

  private targetIndex(key: string): number | undefined {
    const count = this.options.length;
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    const step = steps[key];
    if (!step) return undefined;
    const horizontal = key === "ArrowLeft" || key === "ArrowRight";
    const flip = horizontal && getComputedStyle(this).direction === "rtl" ? -1 : 1;
    return (this.selectedIndex + step * flip + count) % count;
  }

  private get selectedIndex() {
    return Math.max(
      0,
      this.options.findIndex((option) => option.value === this.value),
    );
  }
}

defineOnce("mow-planner-segmented", SegmentedControl);

declare global {
  interface HTMLElementTagNameMap {
    "mow-planner-segmented": SegmentedControl;
  }
}
