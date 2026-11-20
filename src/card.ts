import { mdiAlertOutline, mdiBattery, mdiCheckCircleOutline, mdiPlay, mdiRefresh } from "@mdi/js";
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import "./components/map-view";
import "./components/settings-panel";
import { mdiIcon } from "./components/icons";
import type { MapStrings } from "./components/map-view";
import { CARD_TYPE, configForm, normalizeConfig, stubConfig, type CardConfig } from "./config";
import { previewArea } from "./geo/preview";
import { projectMap, projectPosition } from "./geo/project";
import {
  fetchMap,
  fetchPlannedRoute,
  findMowers,
  readMower,
  requestPlannedRoute,
  startMow,
  startMowData,
  type AreaSwitch,
  type Mower,
} from "./ha/mower";
import type { HomeAssistant } from "./ha/types";
import { isRtl, localize, type StringKey } from "./localize";
import type { AreaPreview, MapModel, Marker, MowSettings, Point } from "./model";
import { controlStyles } from "./styles";

const STEPS = ["areas", "settings", "review"] as const;
type Step = (typeof STEPS)[number];

type MapState =
  { readonly status: "loading" | "empty" | "error" } | { readonly status: "ready"; readonly model: MapModel };

type StartState = "idle" | "confirming" | "sending" | "sent" | "failed";

type RouteState =
  | { readonly status: "idle" | "loading" | "unavailable" }
  | { readonly status: "ready"; readonly lines: readonly (readonly Point[])[] };

const ACTIVE_STATES: readonly string[] = ["mowing", "paused", "returning"];
const OFFLINE_STATES: readonly string[] = ["unavailable", "unknown"];
const ROUTE_POLL_MS = 2000;
const ROUTE_POLLS = 10;
/** Keeps a double tap on Start from also confirming it. */
const CONFIRM_ARM_MS = 600;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MowPlannerCard extends LitElement {
  static getConfigForm = () => configForm;
  static getStubConfig = stubConfig;

  @state() private config?: CardConfig;
  @state() private mowerIds: readonly string[] = [];
  @state() private mowerId?: string;
  @state() private mower?: Mower;
  @state() private language?: string;
  @state() private step: Step = "areas";
  @state() private pickedHashes?: readonly number[];
  @state() private editedSettings?: MowSettings;
  @state() private map: MapState = { status: "loading" };
  @state() private previews: readonly AreaPreview[] = [];
  @state() private route: RouteState = { status: "idle" };
  @state() private start: StartState = "idle";
  @state() private confirmArmed = false;

  private latestHass?: HomeAssistant;
  private mowerSnapshot = "";

  setConfig(config: unknown): void {
    this.config = normalizeConfig(config);
    if (this.latestHass) this.hass = this.latestHass;
  }

  set hass(hass: HomeAssistant) {
    this.latestHass = hass;
    this.language = hass.locale?.language ?? hass.language;
    this.dir = isRtl(hass) ? "rtl" : "ltr";
    const offered = this.config?.entities?.filter((id) => id in hass.states) ?? findMowers(hass);
    if (offered.join() !== this.mowerIds.join()) this.mowerIds = offered;
    if (!this.mowerId || !offered.includes(this.mowerId)) this.mowerId = offered[0];
    const mower = this.mowerId ? readMower(hass, this.mowerId) : undefined;
    const snapshot = JSON.stringify(mower);
    if (snapshot !== this.mowerSnapshot) {
      this.mowerSnapshot = snapshot;
      this.mower = mower;
    }
  }

  getCardSize(): number {
    return 10;
  }

  getGridOptions(): Record<string, number | string> {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  private get settings(): MowSettings | undefined {
    return this.editedSettings ?? this.mower?.settings;
  }

  private get selectedAreas(): readonly AreaSwitch[] {
    const areas = this.mower?.areas ?? [];
    if (!this.pickedHashes) return areas.filter((area) => area.on);
    return this.pickedHashes.flatMap((hash) => areas.find((area) => area.hash === hash) ?? []);
  }

  private get blocker(): StringKey | undefined {
    const { mower, settings } = this;
    if (!mower || OFFLINE_STATES.includes(mower.state)) return "warn.unavailable";
    if (this.selectedAreas.length === 0) return "warn.no_area";
    if (settings?.pattern === "no_grid" && settings.perimeterLaps + settings.obstacleLaps === 0) {
      return "warn.no_path";
    }
    return undefined;
  }

  private t(key: StringKey, vars?: Record<string, string | number>): string {
    return localize(this.language, key, vars);
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("mowerId")) this.resetPlan();
    const planChanged = ["pickedHashes", "editedSettings", "mower", "config"].some((key) => changed.has(key));
    if (planChanged || changed.has("map")) this.previews = this.computePreviews();
  }

  protected override updated(changed: PropertyValues): void {
    if (changed.has("mowerId")) void this.loadMap();
  }

  private resetPlan(): void {
    this.step = "areas";
    this.pickedHashes = undefined;
    this.editedSettings = undefined;
    this.forgetOutcome();
  }

  private forgetOutcome(): void {
    this.route = { status: "idle" };
    this.start = "idle";
  }

  private computePreviews(): AreaPreview[] {
    const { settings } = this;
    if (this.map.status !== "ready" || !settings) return [];
    const { areas, obstacles } = this.map.model;
    return this.selectedAreas.flatMap(({ hash }) => {
      const area = areas.find((zone) => zone.hash === hash);
      return area ? previewArea(area, obstacles, settings, this.config?.angle_offset) : [];
    });
  }

  private async loadMap(): Promise<void> {
    const { mowerId, latestHass: hass } = this;
    if (!mowerId || !hass) return;
    this.map = { status: "loading" };
    let map: MapState;
    try {
      const geojson = await fetchMap(hass, mowerId);
      const model = geojson && projectMap(geojson);
      map = model ? { status: "ready", model: this.withSwitchNames(model) } : { status: "empty" };
    } catch {
      map = { status: "error" };
    }
    if (mowerId === this.mowerId) this.map = map;
  }

  /** The switches name unnamed areas differently from the map; the switches are what the user knows. */
  private withSwitchNames(model: MapModel): MapModel {
    const names = new Map(this.mower?.areas.map((area) => [area.hash, area.name]));
    return {
      ...model,
      areas: model.areas.map((zone) => ({ ...zone, name: names.get(zone.hash) ?? zone.name })),
    };
  }

  private toggleArea(hash: number): void {
    if (!this.mower?.areas.some((area) => area.hash === hash)) return;
    const hashes = this.selectedAreas.map((area) => area.hash);
    this.pickedHashes = hashes.includes(hash) ? hashes.filter((h) => h !== hash) : [...hashes, hash];
    this.forgetOutcome();
  }

  private toggleAll(): void {
    const areas = this.mower?.areas ?? [];
    this.pickedHashes = this.selectedAreas.length === areas.length ? [] : areas.map((area) => area.hash);
    this.forgetOutcome();
  }

  private editSettings(event: CustomEvent<{ settings: MowSettings }>): void {
    this.editedSettings = event.detail.settings;
    this.forgetOutcome();
  }

  private goTo(step: Step): void {
    this.step = step;
    if (this.start !== "sent") this.start = "idle";
  }

  private async askToStart(): Promise<void> {
    this.confirmArmed = false;
    this.start = "confirming";
    await wait(CONFIRM_ARM_MS);
    this.confirmArmed = true;
  }

  private async sendStart(): Promise<void> {
    const { latestHass: hass, mower, settings } = this;
    if (!hass || !mower || !settings || this.blocker || this.start !== "confirming") return;
    this.start = "sending";
    try {
      await startMow(
        hass,
        mower.entityId,
        startMowData(
          settings,
          this.selectedAreas.map((area) => area.entityId),
        ),
      );
      this.start = "sent";
    } catch {
      this.start = "failed";
    }
  }

  private async loadRoute(): Promise<void> {
    const { latestHass: hass, mower, settings, map } = this;
    if (!hass || !mower || !settings || map.status !== "ready") return;
    const loading: RouteState = { status: "loading" };
    this.route = loading;
    let route: RouteState = { status: "unavailable" };
    try {
      const areas = this.selectedAreas.map((area) => area.entityId);
      await startMow(hass, mower.entityId, startMowData(settings, areas, true));
      await requestPlannedRoute(hass, mower.entityId);
      for (let poll = 0; poll < ROUTE_POLLS && this.route === loading && this.isConnected; poll++) {
        await wait(ROUTE_POLL_MS);
        const geojson = await fetchPlannedRoute(hass, mower.entityId);
        const lines = geojson?.features.flatMap(({ geometry }) =>
          geometry.type === "LineString"
            ? [geometry.coordinates.map(([lon = 0, lat = 0]) => projectPosition(map.model.origin, lon, lat))]
            : [],
        );
        if (lines?.length) {
          route = { status: "ready", lines };
          break;
        }
      }
    } catch {
      route = { status: "unavailable" };
    }
    if (this.route === loading) this.route = route;
  }

  private get mapStrings(): MapStrings {
    return {
      mapLabel: this.t("map.label"),
      zoomIn: this.t("map.zoom_in"),
      zoomOut: this.t("map.zoom_out"),
      fit: this.t("map.fit"),
      dock: this.t("map.dock"),
      mower: this.t("map.mower"),
      noGoZone: this.t("map.no_go_zone"),
      area: ({ name, areaM2, order }) =>
        [
          this.t("map.area_label", { name, size: Math.round(areaM2) }),
          ...(order ? [this.t("map.area_selected", { order })] : []),
        ].join(", "),
    };
  }

  private get mowerMarker(): Marker | undefined {
    const position = this.mower?.position;
    if (!position || this.map.status !== "ready") return undefined;
    return {
      position: projectPosition(this.map.model.origin, position.lon, position.lat),
      ...(position.headingDeg !== undefined && { headingDeg: position.headingDeg }),
    };
  }

  private areaCount(count: number): string {
    return count === 1 ? this.t("summary.area_one") : this.t("summary.areas", { count });
  }

  private get pathLengthM(): number {
    return this.previews.reduce((sum, preview) => sum + preview.lengthM, 0);
  }

  private get duration(): string | undefined {
    const speed = this.settings?.speed ?? 0;
    if (this.pathLengthM <= 0 || speed <= 0) return undefined;
    const total = Math.max(1, Math.round(this.pathLengthM / speed / 60));
    const [hours, minutes] = [Math.floor(total / 60), total % 60];
    return hours > 0
      ? this.t("summary.duration_hours", { hours, minutes })
      : this.t("summary.duration", { minutes });
  }

  /** Area count, size and time of the plan, as short phrases. */
  private get totals(): string[] {
    const selected = this.selectedAreas;
    const zones = this.map.status === "ready" ? this.map.model.areas : [];
    const size = selected.reduce(
      (sum, area) => sum + (zones.find((zone) => zone.hash === area.hash)?.areaM2 ?? 0),
      0,
    );
    return [
      this.areaCount(selected.length),
      ...(size > 0 ? [this.t("summary.area_size", { size: Math.round(size) })] : []),
      ...(this.duration ? [this.duration] : []),
    ];
  }

  protected override render(): TemplateResult {
    const { mower } = this;
    if (!mower) return html`<ha-card><p class="message" role="status">${this.t("mower.none")}</p></ha-card>`;
    return html`
      <ha-card>
        ${this.renderHeader(mower)}
        <div class="layout">
          ${this.renderMap()}
          <div class="plan">
            ${this.renderSteps()}
            <div class="panel">${this.renderStep(mower)}</div>
            ${this.renderFooter(mower)}
          </div>
        </div>
      </ha-card>
    `;
  }

  private renderHeader(mower: Mower): TemplateResult {
    const stateKey = `state.${mower.state}`;
    const stateText = stateKey in STATE_KEYS ? this.t(stateKey as StringKey) : this.t("state.unavailable");
    const battery =
      mower.battery === undefined
        ? nothing
        : html` ·
            <svg class="icon inline" viewBox="0 0 24 24" aria-hidden="true">${mdiIcon(mdiBattery)}</svg>
            ${this.t("mower.battery", { percent: Math.round(mower.battery) })}`;
    return html`
      <header>
        <div class="title">
          ${this.config?.title || this.mowerIds.length < 2 ? html`<h2>${this.config?.title ?? mower.name}</h2>` : nothing}
          ${this.mowerIds.length > 1 ? this.renderMowerPicker() : nothing}
          <span class="secondary">${stateText}${battery}</span>
        </div>
        <button
          class="icon-button"
          aria-label=${this.t("map.refresh")}
          title=${this.t("map.refresh")}
          ?disabled=${this.map.status === "loading"}
          @click=${() => void this.loadMap()}
        >
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${mdiIcon(mdiRefresh)}</svg>
        </button>
      </header>
    `;
  }

  private renderMowerPicker(): TemplateResult {
    const hass = this.latestHass;
    return html`
      <select
        aria-label=${this.t("mower.pick")}
        @change=${(event: Event) => (this.mowerId = (event.target as HTMLSelectElement).value)}
      >
        ${this.mowerIds.map(
          (id) =>
            html`<option value=${id} ?selected=${id === this.mowerId}>
              ${(hass && readMower(hass, id)?.name) ?? id}
            </option>`,
        )}
      </select>
    `;
  }

  private renderMap(): TemplateResult {
    const { map } = this;
    const approximate = this.route.status !== "ready" && this.previews.some((p) => !p.directionExact);
    return html`
      <div class="map">
        ${
          map.status === "ready"
            ? html`<mmp-map
                .model=${map.model}
                .selected=${this.selectedAreas.map((area) => area.hash)}
                .previews=${this.previews}
                .mower=${this.mowerMarker}
                .route=${this.route.status === "ready" ? this.route.lines : undefined}
                .strings=${this.mapStrings}
                ?readonly=${this.step === "review"}
                @area-toggle=${(event: CustomEvent<{ hash: number }>) => {
                  this.toggleArea(event.detail.hash);
                }}
              ></mmp-map>`
            : html`<p class="message" role="status">
                ${this.t(
                  map.status === "loading"
                    ? "map.loading"
                    : map.status === "empty"
                      ? "map.unavailable"
                      : "map.error",
                )}
              </p>`
        }
        ${approximate ? html`<p class="note secondary">${this.t("preview.approximate")}</p>` : nothing}
      </div>
    `;
  }

  private renderSteps(): TemplateResult {
    return html`
      <nav aria-label=${this.t("step.label")}>
        <ol>
          ${STEPS.map(
            (step, index) => html`
              <li>
                <button
                  class="step"
                  aria-current=${step === this.step ? "step" : "false"}
                  @click=${() => {
                    this.goTo(step);
                  }}
                >
                  <span class="badge" aria-hidden="true">${index + 1}</span>${this.t(`step.${step}`)}
                </button>
              </li>
            `,
          )}
        </ol>
      </nav>
    `;
  }

  private renderStep(mower: Mower): TemplateResult {
    if (this.step === "areas") return this.renderAreas(mower);
    if (this.step === "review") return this.renderReview(mower);
    return html`<mmp-settings
      .settings=${this.settings}
      .limits=${mower.limits}
      .language=${this.language}
      @settings-changed=${(event: CustomEvent<{ settings: MowSettings }>) => {
        this.editSettings(event);
      }}
    ></mmp-settings>`;
  }

  private renderAreas(mower: Mower): TemplateResult {
    if (mower.areas.length === 0) return html`<p class="secondary">${this.t("areas.none_available")}</p>`;
    const selected = this.selectedAreas;
    return html`
      <p class="secondary hint">${this.t("areas.hint")}</p>
      <div class="chips">
        <button
          class="chip"
          aria-pressed=${selected.length === mower.areas.length}
          @click=${() => {
            this.toggleAll();
          }}
        >
          ${this.t("areas.all")}
        </button>
        ${mower.areas.map((area) => {
          const order = selected.indexOf(area) + 1;
          return html`
            <button
              class="chip"
              aria-pressed=${order > 0}
              @click=${() => {
                this.toggleArea(area.hash);
              }}
            >
              ${order > 0 ? html`<span class="badge">${order}</span>` : nothing}${area.name}
            </button>
          `;
        })}
      </div>
    `;
  }

  private renderReview(mower: Mower): TemplateResult {
    const { settings } = this;
    if (!settings) return html``;
    const striped = settings.pattern !== "no_grid";
    const angle =
      settings.angleMode === "random_angle"
        ? this.t("angle_mode.random_angle")
        : `${this.t(`angle_mode.${settings.angleMode}`)}, ${this.t("unit.degrees", { value: settings.angle })}`;
    const rows: (readonly [string, string | number] | false | undefined)[] = [
      [this.t("step.areas"), this.selectedAreas.map((area) => area.name).join(" → ") || "–"],
      [this.t("settings.pattern"), this.t(`pattern.${settings.pattern}`)],
      striped && [this.t("settings.angle"), angle],
      settings.pattern === "double_grid" && [
        this.t("settings.cross_angle"),
        this.t("unit.degrees", { value: settings.crossAngle }),
      ],
      [this.t("settings.spacing"), this.t("unit.cm", { value: settings.spacingCm })],
      [this.t("settings.perimeter_laps"), settings.perimeterLaps],
      [this.t("settings.obstacle_laps"), settings.obstacleLaps],
      striped && [this.t("settings.mow_order"), this.t(`mow_order.${settings.mowOrder}`)],
      [this.t("settings.speed"), this.t("unit.speed", { value: settings.speed })],
      settings.bladeHeight !== undefined && [
        this.t("settings.blade_height"),
        this.t("unit.mm", { value: settings.bladeHeight }),
      ],
      this.pathLengthM > 0 && [
        this.t("review.distance"),
        this.t("summary.distance", { km: (this.pathLengthM / 1000).toFixed(1) }),
      ],
      this.duration !== undefined && [this.t("review.estimate"), this.duration],
    ];
    const canFetchRoute =
      this.config?.exact_route &&
      this.map.status === "ready" &&
      !this.blocker &&
      !ACTIVE_STATES.includes(mower.state);
    return html`
      <dl>
        ${rows.map((row) =>
          row
            ? html`<div>
                <dt>${row[0]}</dt>
                <dd>${row[1]}</dd>
              </div>`
            : nothing,
        )}
      </dl>
      ${
        canFetchRoute
          ? html`<button
                class="text-button"
                ?disabled=${this.route.status === "loading"}
                @click=${() => void this.loadRoute()}
              >
                ${this.t(this.route.status === "loading" ? "preview.exact_route_loading" : "preview.exact_route")}
              </button>
              ${
                this.route.status === "unavailable"
                  ? html`<p class="secondary" role="status">${this.t("preview.exact_route_unavailable")}</p>`
                  : nothing
              }`
          : nothing
      }
      ${ACTIVE_STATES.includes(mower.state) ? this.renderAlert("warning", "warn.active_job", mower) : nothing}
    `;
  }

  private renderAlert(kind: "warning" | "error" | "success", key: StringKey, mower: Mower): TemplateResult {
    return html`
      <p class="alert ${kind}" role=${kind === "success" ? "status" : "alert"}>
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
          ${mdiIcon(kind === "success" ? mdiCheckCircleOutline : mdiAlertOutline)}
        </svg>
        ${this.t(key, { name: mower.name })}
      </p>
    `;
  }

  private renderFooter(mower: Mower): TemplateResult {
    const { blocker, step, start } = this;
    const index = STEPS.indexOf(step);
    const next = STEPS[index + 1];
    const back = STEPS[index - 1];
    if (step === "review" && start === "confirming") {
      return html`
        <footer class="confirm" role="alertdialog" aria-label=${this.t("action.start")}>
          <p>${this.t("start.confirm", { name: mower.name, areas: this.totals.join(" · ") })}</p>
          <div class="actions">
            <button
              class="text-button"
              @click=${() => {
                this.start = "idle";
              }}
            >
              ${this.t("action.cancel")}
            </button>
            <button class="primary" ?disabled=${!this.confirmArmed} @click=${() => void this.sendStart()}>
              ${this.t("action.confirm_start")}
            </button>
          </div>
        </footer>
      `;
    }
    return html`
      <footer>
        ${step === "review" && start === "sent" ? this.renderAlert("success", "start.sent", mower) : nothing}
        ${step === "review" && start === "failed" ? this.renderAlert("error", "start.failed", mower) : nothing}
        ${
          blocker && (step === "review" || blocker === "warn.no_area")
            ? this.renderAlert("error", blocker, mower)
            : nothing
        }
        <div class="actions">
          <span class="secondary totals" aria-live="polite">${this.totals.join(" · ")}</span>
          ${
            back
              ? html`<button
                  class="text-button"
                  @click=${() => {
                    this.goTo(back);
                  }}
                >
                  ${this.t("action.back")}
                </button>`
              : nothing
          }
          ${
            next
              ? html`<button
                  class="primary"
                  ?disabled=${blocker === "warn.no_area"}
                  @click=${() => {
                    this.goTo(next);
                  }}
                >
                  ${this.t("action.next")}
                </button>`
              : html`<button
                  class="primary"
                  ?disabled=${Boolean(blocker) || start === "sending"}
                  @click=${() => void this.askToStart()}
                >
                  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${mdiIcon(mdiPlay)}</svg>
                  ${this.t(start === "sending" ? "action.starting" : "action.start")}
                </button>`
          }
        </div>
      </footer>
    `;
  }

  static override styles = [
    controlStyles,
    css`
      :host {
        display: block;
      }
      ha-card {
        container-type: inline-size;
      }
      header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 8px 8px 16px;
        padding-inline: 16px 8px;
      }
      .title {
        flex: 1;
        min-width: 0;
      }
      h2 {
        margin: 0;
        font-size: var(--ha-font-size-l, 16px);
        font-weight: var(--ha-font-weight-medium, 500);
        line-height: 1.3;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .icon.inline {
        width: 14px;
        height: 14px;
        vertical-align: -2px;
      }
      select {
        display: block;
        font: inherit;
        font-size: var(--ha-font-size-l, 16px);
        font-weight: var(--ha-font-weight-medium, 500);
        color: inherit;
        height: var(--mmp-control-height);
        max-width: 100%;
        margin-block-end: 2px;
        padding-inline: 12px;
        border: none;
        border-radius: var(--mmp-radius);
        background: var(--mmp-surface);
      }
      .icon-button {
        display: grid;
        place-items: center;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        color: var(--secondary-text-color, #727272);
      }
      .icon-button:hover:not(:disabled) {
        background: var(--mmp-surface);
      }
      .map {
        position: sticky;
        top: calc(var(--header-height, 0px) + var(--safe-area-inset-top, 0px));
        z-index: 1;
        height: clamp(200px, 62cqw, 380px);
        background: color-mix(
          in srgb,
          var(--primary-text-color, #212121) 6%,
          var(--card-background-color, #fff)
        );
      }
      mmp-map {
        height: 100%;
      }
      .message {
        margin: 0;
        padding: 32px 16px;
        text-align: center;
        color: var(--secondary-text-color, #727272);
      }
      .map .message {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
      }
      .note {
        position: absolute;
        inset-inline-start: 8px;
        top: 8px;
        max-width: calc(100% - 80px);
        margin: 0;
        padding: 4px 8px;
        width: fit-content;
        border-radius: var(--ha-border-radius-md, 8px);
        background: color-mix(in srgb, var(--card-background-color, #fff) 85%, transparent);
        pointer-events: none;
      }
      .plan {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      ol {
        display: flex;
        gap: 4px;
        margin: 0;
        padding: 8px 12px 0;
        list-style: none;
      }
      li {
        flex: 1;
        min-width: 0;
      }
      .step {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        width: 100%;
        height: var(--mmp-control-height);
        border-radius: var(--mmp-radius);
        color: var(--secondary-text-color, #727272);
        font-weight: var(--ha-font-weight-medium, 500);
      }
      .step:hover {
        background: var(--mmp-surface);
      }
      .step[aria-current="step"] {
        background: var(--mmp-tint);
        color: var(--primary-text-color, #212121);
      }
      .badge {
        display: inline-grid;
        place-items: center;
        min-width: 20px;
        height: 20px;
        border-radius: 10px;
        background: var(--mmp-surface);
        font-size: var(--ha-font-size-s, 12px);
        font-weight: var(--ha-font-weight-medium, 500);
      }
      [aria-current="step"] .badge,
      [aria-pressed="true"] .badge {
        background: var(--mmp-accent);
        color: var(--text-primary-color, #fff);
      }
      .panel {
        padding: 12px 16px 4px;
        min-height: 96px;
      }
      .hint {
        margin: 0 0 8px;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: var(--mmp-control-height);
        padding-inline: 14px;
        border-radius: var(--mmp-radius);
        background: var(--mmp-surface);
        font-weight: var(--ha-font-weight-medium, 500);
      }
      .chip[aria-pressed="true"] {
        background: var(--mmp-tint);
      }
      dl {
        margin: 0;
      }
      dl div {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding-block: 6px;
        border-bottom: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
      }
      dl div:last-child {
        border-bottom: none;
      }
      dt {
        color: var(--secondary-text-color, #727272);
      }
      dd {
        margin: 0;
        text-align: end;
        font-weight: var(--ha-font-weight-medium, 500);
      }
      footer {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: auto;
        padding: 8px 16px 16px;
      }
      footer p {
        margin: 0;
      }
      .actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
      }
      .totals {
        flex: 1 1 100%;
        min-width: 0;
      }
      .actions {
        flex-wrap: wrap;
      }
      @container (min-width: 440px) {
        .totals {
          flex-basis: 0;
        }
      }
      .primary,
      .text-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: var(--mmp-control-height);
        padding-inline: 18px;
        border-radius: var(--mmp-radius);
        font-weight: var(--ha-font-weight-medium, 500);
        white-space: nowrap;
      }
      .primary {
        background: var(--mmp-accent);
        color: var(--text-primary-color, #fff);
      }
      .primary:disabled {
        background: var(--mmp-surface);
        color: var(--disabled-text-color, #9e9e9e);
      }
      .text-button {
        color: var(--mmp-accent);
      }
      .text-button:hover:not(:disabled) {
        background: var(--mmp-tint);
      }
      .alert {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 8px 0 0;
        padding: 8px 12px;
        border-radius: var(--ha-border-radius-md, 8px);
        --alert-color: var(--error-color, #db4437);
        background: color-mix(in srgb, var(--alert-color) 14%, transparent);
      }
      .alert .icon {
        color: var(--alert-color);
      }
      .alert.warning {
        --alert-color: var(--warning-color, #ffa600);
      }
      .alert.success {
        --alert-color: var(--success-color, #43a047);
      }
      @container (min-width: 720px) {
        .layout {
          display: grid;
          grid-template-columns: minmax(0, 1.2fr) minmax(300px, 1fr);
        }
        .map {
          position: relative;
          top: 0;
          height: auto;
          min-height: 420px;
          border-end-start-radius: var(--ha-card-border-radius, 12px);
        }
      }
    `,
  ];
}

const STATE_KEYS = {
  "state.mowing": true,
  "state.paused": true,
  "state.returning": true,
  "state.docked": true,
  "state.idle": true,
  "state.error": true,
};

if (!customElements.get(CARD_TYPE)) customElements.define(CARD_TYPE, MowPlannerCard);

declare global {
  interface Window {
    customCards?: { type: string; name: string; description: string; preview?: boolean }[];
  }
}

(window.customCards ??= []).push({
  type: CARD_TYPE,
  name: "Mammotion Mow Planner",
  description: "Pick areas on the map, preview the mowing pattern and start the job.",
});
