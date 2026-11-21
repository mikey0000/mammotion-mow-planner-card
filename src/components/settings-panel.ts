import { defineOnce } from "../define";
import { mdiAngleAcute, mdiAutoFix, mdiChevronDown, mdiShuffleVariant } from "@mdi/js";
import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { localize, type StringKey } from "../localize";
import {
  ANGLE_MODES,
  MOW_ORDERS,
  PATTERNS,
  type AngleMode,
  type MowSettings,
  type Range,
  type SettingLimits,
  type SettingName,
  type SwitchSetting,
} from "../model";
import { controlStyles } from "../styles";
import "./control-dial";
import type { DialHand } from "./control-dial";
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

/** Where the Optimal direction stands: guessed by the card, being asked of the mower, or taken from its plan. */
export type OptimalState = "approximate" | "finding" | "found" | "failed" | "unsupported";

const SWITCH_LABELS: Readonly<Record<SwitchSetting, StringKey>> = {
  autoChangeDirection: "settings.auto_change_direction",
  cutGrass: "settings.cut_grass",
  dumpGrass: "settings.dump_grass",
  cutEdges: "settings.cut_edges",
};

type Value<K extends SettingName> = NonNullable<MowSettings[K]>;

/** Mowing settings form; fully controlled: fires `settings-changed` with a new settings object per change. */
export class MowSettingsPanel extends LitElement {
  @property({ attribute: false }) settings!: MowSettings;
  @property({ attribute: false }) limits!: SettingLimits;
  @property({ attribute: false }) language?: string;
  @property({ attribute: false }) disabled = false;
  /** Settings shown but not editable; while any are, More settings starts open. */
  @property({ attribute: false }) locked: readonly SettingName[] = [];
  /** Map direction an angle of 0 points along, for the dial. */
  @property({ attribute: false }) angleBase = 0;
  /** Offers finding the Optimal direction from a plan when set; fires `find-optimal`. */
  @property({ attribute: false }) optimal?: OptimalState;
  /** The integration's reason for a failed attempt, shown instead of the generic one. */
  @property({ attribute: false }) optimalError?: string;

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
      .angles {
        display: flex;
        align-items: center;
        gap: var(--ha-space-3, 12px);
      }
      .sliders {
        display: flex;
        flex-direction: column;
        gap: var(--ha-space-3, 12px);
        flex: 1;
        min-width: 0;
      }
      .optimal {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--ha-space-1, 4px) var(--ha-space-3, 12px);
        margin: 0;
      }
      .optimal button {
        min-height: 32px;
        padding-inline: var(--ha-space-2, 8px);
        border-radius: var(--mmp-radius);
        color: var(--mmp-accent);
        font-weight: var(--ha-font-weight-medium, 500);
      }
      .optimal button:hover:not(:disabled) {
        background: var(--mmp-tint);
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
      details > mow-planner-slider,
      details > .group {
        margin-block-start: var(--ha-space-3, 12px);
      }
      .group {
        margin-block-end: 0;
        font-weight: var(--ha-font-weight-medium, 500);
      }
    `,
  ];

  protected override render() {
    const { settings: s, limits: l } = this;
    const perimeterOnly = s.pattern === "no_grid";
    const switches = l.switches ?? [];
    const collecting = switches.filter((name) => name !== "autoChangeDirection");
    return html`
      ${this.segmented(
        "pattern",
        "settings.pattern",
        PATTERNS.filter((p) => l.patterns.includes(p)).map((p) => ({
          value: p,
          label: this.t(`pattern.${p}`),
          icon: patternIcons[p],
        })),
        s.pattern,
      )}
      ${perimeterOnly ? nothing : this.renderAngle()}
      ${this.slider("spacingCm", "settings.spacing", l.spacingCm, s.spacingCm, (v) => this.unit("unit.cm", v))}
      ${this.segmented("perimeterLaps", "settings.perimeter_laps", this.laps(l.maxPerimeterLaps), s.perimeterLaps)}
      ${this.segmented("obstacleLaps", "settings.obstacle_laps", this.laps(l.maxObstacleLaps), s.obstacleLaps)}
      ${
        perimeterOnly
          ? nothing
          : this.segmented(
              "mowOrder",
              "settings.mow_order",
              MOW_ORDERS.map((order) => ({ value: order, label: this.t(`mow_order.${order}`) })),
              s.mowOrder,
            )
      }
      <details ?open=${this.locked.length > 0}>
        <summary>
          ${this.t("settings.more")}
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${mdiIcon(mdiChevronDown)}</svg>
        </summary>
        ${this.slider("speed", "settings.speed", l.speed, s.speed, (v) => this.unit("unit.speed", v, 1))}
        ${
          l.bladeHeight
            ? this.slider(
                "bladeHeight",
                "settings.blade_height",
                l.bladeHeight,
                s.bladeHeight ?? l.bladeHeight.min,
                (v) => this.unit("unit.mm", v),
              )
            : nothing
        }
        ${l.edgeDistance ? this.renderEdge() : nothing}
        ${
          l.obstacleDetection && s.obstacleDetection !== undefined
            ? this.segmented(
                "obstacleDetection",
                "settings.detection",
                l.obstacleDetection.map(({ key, code }) => ({
                  value: code,
                  label: this.t(`detection.${key}`),
                })),
                s.obstacleDetection,
              )
            : nothing
        }
        ${switches.includes("autoChangeDirection") ? this.toggle("autoChangeDirection") : nothing}
        ${
          l.startProgress
            ? this.slider(
                "startProgress",
                "settings.start_progress",
                l.startProgress,
                s.startProgress ?? 0,
                (v) => this.unit("unit.percent", v),
              )
            : nothing
        }
        ${
          collecting.length > 0 || l.dumpInterval
            ? html`<p class="group">${this.t("settings.collection")}</p>
                ${collecting.map((name) => this.toggle(name))}
                ${
                  l.dumpInterval && s.dumpGrass !== false
                    ? this.slider(
                        "dumpInterval",
                        "settings.dump_interval",
                        l.dumpInterval,
                        s.dumpInterval ?? 0,
                        (v) => this.unit("unit.m2", v),
                      )
                    : nothing
                }`
            : nothing
        }
      </details>
    `;
  }

  private renderAngle() {
    const { settings: s, limits: l } = this;
    const modes = ANGLE_MODES.filter((mode) => l.angleModes.includes(mode)).map((mode) => ({
      value: mode,
      label: this.t(`angle_mode.${mode}`),
      icon: mdiIcon(angleModeIcons[mode]),
    }));
    const format =
      s.angleMode === "relative_angle"
        ? (v: number) => this.t("angle.offset", { value: this.number(v, 0, "exceptZero") })
        : (v: number) => this.degrees(v);
    const crossing = s.pattern === "double_grid";
    const cross = crossing
      ? this.slider(
          "crossAngle",
          "settings.cross_angle",
          l.crossAngle,
          s.crossAngle,
          (v) => this.degrees(v),
          90,
        )
      : nothing;
    return html`${this.segmented("angleMode", "settings.angle", modes, s.angleMode, [
      html`<p class="help secondary">${this.t(`angle_help.${s.angleMode}`)}</p>`,
      s.angleMode === "relative_angle" ? this.renderOptimal() : nothing,
    ])}
    ${
      s.angleMode === "random_angle"
        ? cross
        : html`<div class="angles">
            <div class="sliders">
              ${this.slider("angle", "settings.angle_value", l.angle, s.angle, format, 0)} ${cross}
            </div>
            <mow-planner-dial
              .angle=${s.angle}
              .crossAngle=${crossing ? s.crossAngle : undefined}
              .base=${this.angleBase}
              .reference=${s.angleMode === "relative_angle"}
              .angleRange=${l.angle}
              .crossRange=${l.crossAngle}
              .angleLabel=${this.t("settings.angle_value")}
              .crossLabel=${this.t("settings.cross_angle")}
              .format=${(v: number) => this.degrees(v)}
              .disabled=${this.isLocked("angle") || this.isLocked("crossAngle")}
              @value-changed=${(event: CustomEvent<{ hand: DialHand; value: number }>) => {
                this.emit(event.detail.hand, event.detail.value);
              }}
            ></mow-planner-dial>
          </div>`
    }`;
  }

  private renderOptimal() {
    const { optimal } = this;
    if (!optimal) return nothing;
    return html`<p class="optimal secondary" role="status">
      ${optimal === "failed" && this.optimalError ? this.optimalError : this.t(`optimal.${optimal}`)}
      ${
        optimal === "approximate" || optimal === "failed"
          ? html`<button
              type="button"
              ?disabled=${this.disabled}
              @click=${() => {
                this.dispatchEvent(new CustomEvent("find-optimal", { bubbles: true, composed: true }));
              }}
            >
              ${this.t("optimal.find")}
            </button>`
          : nothing
      }
    </p>`;
  }

  private renderEdge() {
    const stored = this.settings.edgeDistance ?? 0;
    const nearest = EDGE_CHOICES.reduce((a, b) => (Math.abs(b - stored) < Math.abs(a - stored) ? b : a));
    return this.segmented(
      "edgeDistance",
      "settings.edge",
      EDGE_CHOICES.map((value) => ({ value, label: this.t(value ? "edge.on" : "edge.inside") })),
      nearest,
    );
  }

  private toggle(name: SwitchSetting) {
    const options = [false, true].map((value) => ({
      value,
      label: this.t(value ? "toggle.on" : "toggle.off"),
    }));
    return this.segmented(name, SWITCH_LABELS[name], options, this.settings[name] ?? false);
  }

  private segmented<K extends SettingName>(
    name: K,
    label: StringKey,
    options: readonly SegmentOption<Value<K> & SegmentValue>[],
    value: Value<K> & SegmentValue,
    extra: unknown[] = [],
  ) {
    return html`<div class="field">
      <mow-planner-segmented
        .label=${this.t(label)}
        .options=${options}
        .value=${value}
        .disabled=${this.isLocked(name)}
        @value-changed=${(event: CustomEvent<{ value: Value<K> }>) => {
          this.emit(name, event.detail.value);
        }}
      ></mow-planner-segmented>
      ${extra}
    </div>`;
  }

  private slider(
    name: SettingName,
    label: StringKey,
    range: Range,
    value: number,
    format: (value: number) => string,
    origin?: number,
  ) {
    return html`<mow-planner-slider
      .label=${this.t(label)}
      .range=${range}
      .value=${value}
      .origin=${origin}
      .format=${format}
      .language=${this.language}
      .disabled=${this.isLocked(name)}
      @value-changed=${(event: CustomEvent<{ value: number }>) => {
        this.emit(name, event.detail.value);
      }}
    ></mow-planner-slider>`;
  }

  private isLocked(name: SettingName) {
    return this.disabled || this.locked.includes(name);
  }

  private laps(max: number): SegmentOption<number>[] {
    return Array.from({ length: max + 1 }, (_, value) => ({ value, label: this.number(value) }));
  }

  private emit<K extends SettingName>(name: K, value: MowSettings[K]) {
    this.dispatchEvent(
      new CustomEvent("settings-changed", {
        detail: { settings: { ...this.settings, [name]: value } },
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

defineOnce("mow-planner-settings", MowSettingsPanel);

declare global {
  interface HTMLElementTagNameMap {
    "mow-planner-settings": MowSettingsPanel;
  }
}
