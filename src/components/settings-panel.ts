import { mdiAngleAcute, mdiAutoFix, mdiChevronDown, mdiShuffleVariant } from "@mdi/js";
import { css, html, LitElement, nothing, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import { localize, type StringKey } from "../localize";
import {
  ANGLE_MODES,
  MOW_ORDERS,
  PATTERNS,
  type AngleMode,
  type MowSettings,
  type Range,
  type SettingLimits,
} from "../model";
import { controlStyles } from "../styles";
import "./control-segmented";
import type { SegmentOption, SegmentValue } from "./control-segmented";
import "./control-slider";
import { mdiIcon, patternIcons } from "./icons";

const angleModeIcons: Readonly<Record<AngleMode, string>> = {
  relative_angle: mdiAutoFix,
  absolute_angle: mdiAngleAcute,
  random_angle: mdiShuffleVariant,
};

const EDGE_CHOICES = [0, 0.5] as const;

const DIAL_RADIUS = 16;
const dialStripes = [-12, -6, 0, 6, 12].map((y) => {
  const x = Math.sqrt(DIAL_RADIUS ** 2 - y ** 2);
  return svg`<line x1=${-x} y1=${y} x2=${x} y2=${y}></line>`;
});

/** Mowing settings form; fully controlled: fires `settings-changed` with a new settings object per change. */
@customElement("mmp-settings")
export class MowSettingsPanel extends LitElement {
  @property({ attribute: false }) settings!: MowSettings;
  @property({ attribute: false }) limits!: SettingLimits;
  @property({ attribute: false }) language?: string;
  @property({ attribute: false }) disabled = false;

  static override styles = [
    controlStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--ha-space-3, 12px);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--ha-space-1, 4px);
      }
      .help {
        margin: 0;
      }
      .angle {
        display: flex;
        align-items: flex-end;
        gap: var(--ha-space-2, 8px);
      }
      .angle mmp-slider {
        flex: 1;
        min-width: 0;
      }
      .dial {
        width: var(--mmp-control-height);
        height: var(--mmp-control-height);
        flex: none;
      }
      .dial circle {
        fill: var(--mmp-surface);
        stroke: var(--divider-color, rgba(0, 0, 0, 0.12));
      }
      .dial .stripes {
        stroke: var(--mmp-accent);
        stroke-width: 2;
        stroke-linecap: round;
      }
      summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: var(--mmp-control-height);
        font-weight: var(--ha-font-weight-medium, 500);
        cursor: pointer;
        list-style: none;
        border-radius: var(--mmp-radius);
      }
      summary::-webkit-details-marker {
        display: none;
      }
      summary .icon {
        transition: transform 150ms;
      }
      details[open] summary .icon {
        transform: rotate(180deg);
      }
      details > .field,
      details > mmp-slider {
        margin-block-start: var(--ha-space-3, 12px);
      }
    `,
  ];

  protected override render() {
    const { settings: s, limits: l } = this;
    const perimeterOnly = s.pattern === "no_grid";
    return html`
      ${this.segmented(
        "settings.pattern",
        PATTERNS.filter((p) => l.patterns.includes(p)).map((p) => ({
          value: p,
          label: this.t(`pattern.${p}`),
          icon: patternIcons[p],
        })),
        s.pattern,
        (pattern) => ({ pattern }),
      )}
      ${perimeterOnly ? nothing : this.renderAngle()}
      ${
        s.pattern === "double_grid"
          ? this.slider(
              "settings.cross_angle",
              l.crossAngle,
              s.crossAngle,
              (v) => this.degrees(v),
              (crossAngle) => ({
                crossAngle,
              }),
            )
          : nothing
      }
      ${this.slider(
        "settings.spacing",
        l.spacingCm,
        s.spacingCm,
        (v) => this.unit("unit.cm", v),
        (spacingCm) => ({
          spacingCm,
        }),
      )}
      ${this.segmented(
        "settings.perimeter_laps",
        this.laps(l.maxPerimeterLaps),
        s.perimeterLaps,
        (perimeterLaps) => ({
          perimeterLaps,
        }),
      )}
      ${this.segmented(
        "settings.obstacle_laps",
        this.laps(l.maxObstacleLaps),
        s.obstacleLaps,
        (obstacleLaps) => ({
          obstacleLaps,
        }),
      )}
      ${
        perimeterOnly
          ? nothing
          : this.segmented(
              "settings.mow_order",
              MOW_ORDERS.map((order) => ({ value: order, label: this.t(`mow_order.${order}`) })),
              s.mowOrder,
              (mowOrder) => ({ mowOrder }),
            )
      }
      <details>
        <summary>
          ${this.t("settings.more")}
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${mdiIcon(mdiChevronDown)}</svg>
        </summary>
        ${this.slider(
          "settings.speed",
          l.speed,
          s.speed,
          (v) => this.unit("unit.speed", v, 1),
          (speed) => ({ speed }),
        )}
        ${
          l.bladeHeight
            ? this.slider(
                "settings.blade_height",
                l.bladeHeight,
                s.bladeHeight ?? l.bladeHeight.min,
                (v) => this.unit("unit.mm", v),
                (bladeHeight) => ({ bladeHeight }),
              )
            : nothing
        }
        ${l.edgeDistance ? this.renderEdge() : nothing}
      </details>
    `;
  }

  private renderAngle() {
    const { angleMode, angle } = this.settings;
    const modes = ANGLE_MODES.filter((mode) => this.limits.angleModes.includes(mode)).map((mode) => ({
      value: mode,
      label: this.t(`angle_mode.${mode}`),
      icon: mdiIcon(angleModeIcons[mode]),
    }));
    const format =
      angleMode === "relative_angle"
        ? (v: number) => this.t("angle.offset", { value: this.number(v, 0, "exceptZero") })
        : (v: number) => this.degrees(v);
    return html`${this.segmented("settings.angle", modes, angleMode, (mode) => ({ angleMode: mode }), [
      html`<p class="help secondary">${this.t(`angle_help.${angleMode}`)}</p>`,
    ])}
    ${
      angleMode === "random_angle"
        ? nothing
        : html`<div class="angle">
            ${this.slider("settings.angle_value", this.limits.angle, angle, format, (value) => ({ angle: value }))}
            <svg class="dial" viewBox="-20 -20 40 40" aria-hidden="true">
              <circle r="19"></circle>
              <g class="stripes" transform="rotate(${-angle})">${dialStripes}</g>
            </svg>
          </div>`
    }`;
  }

  private renderEdge() {
    const stored = this.settings.edgeDistance ?? 0;
    const nearest = EDGE_CHOICES.reduce((a, b) => (Math.abs(b - stored) < Math.abs(a - stored) ? b : a));
    return this.segmented(
      "settings.edge",
      EDGE_CHOICES.map((value) => ({ value, label: this.t(value ? "edge.on" : "edge.inside") })),
      nearest,
      (edgeDistance) => ({ edgeDistance }),
    );
  }

  private segmented<T extends SegmentValue>(
    label: StringKey,
    options: readonly SegmentOption<T>[],
    value: T,
    apply: (value: T) => Partial<MowSettings>,
    extra: unknown[] = [],
  ) {
    const text = this.t(label);
    return html`<div class="field">
      <span class="secondary" aria-hidden="true">${text}</span>
      <mmp-segmented
        .label=${text}
        .options=${options}
        .value=${value}
        .disabled=${this.disabled}
        @value-changed=${(event: CustomEvent<{ value: T }>) => {
          this.emit(apply(event.detail.value));
        }}
      ></mmp-segmented>
      ${extra}
    </div>`;
  }

  private slider(
    label: StringKey,
    range: Range,
    value: number,
    format: (value: number) => string,
    apply: (value: number) => Partial<MowSettings>,
  ) {
    return html`<mmp-slider
      .label=${this.t(label)}
      .range=${range}
      .value=${value}
      .format=${format}
      .language=${this.language}
      .disabled=${this.disabled}
      @value-changed=${(event: CustomEvent<{ value: number }>) => {
        this.emit(apply(event.detail.value));
      }}
    ></mmp-slider>`;
  }

  private laps(max: number): SegmentOption<number>[] {
    return Array.from({ length: max + 1 }, (_, value) => ({ value, label: this.number(value) }));
  }

  private emit(change: Partial<MowSettings>) {
    this.dispatchEvent(
      new CustomEvent("settings-changed", {
        detail: { settings: { ...this.settings, ...change } },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private t(key: StringKey, vars?: Record<string, string | number>) {
    return localize(this.language, key, vars);
  }

  private number(value: number, digits = 0, signDisplay: Intl.NumberFormatOptions["signDisplay"] = "auto") {
    return new Intl.NumberFormat(this.language, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay,
    }).format(value);
  }

  private unit(key: StringKey, value: number, digits = 0) {
    return this.t(key, { value: this.number(value, digits) });
  }

  private degrees(value: number) {
    return this.unit("unit.degrees", value);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mmp-settings": MowSettingsPanel;
  }
}
