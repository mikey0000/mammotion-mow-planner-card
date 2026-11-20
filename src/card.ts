import {
  mdiAlertOutline,
  mdiBattery,
  mdiCheck,
  mdiCheckCircleOutline,
  mdiMapMarkerOffOutline,
  mdiPlay,
  mdiRefresh,
} from "@mdi/js";
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import "./components/map-view";
import "./components/settings-panel";
import { mdiIcon } from "./components/icons";
import type { MapStrings } from "./components/map-view";
import { CARD_TYPE, configForm, normalizeConfig, stubConfig, type CardConfig } from "./config";
import { defineOnce } from "./define";
import { previewArea } from "./geo/preview";
import { projectMap, projectPosition } from "./geo/project";
import {
  fetchMap,
  fetchPlannedRoute,
  findMowers,
  modifyJobData,
  modifyRunningJob,
  mowerName,
  readMower,
  requestPlannedRoute,
  startMow,
  startMowData,
  type AreaSwitch,
  type Mower,
} from "./ha/mower";
import type { HomeAssistant } from "./ha/types";
import { isRtl, localize, type StringKey } from "./localize";
import type { AreaPreview, MapModel, Marker, MowSettings, Point, SettingName } from "./model";
import { controlStyles } from "./styles";

const STEPS = ["areas", "settings", "review"] as const;
type Step = (typeof STEPS)[number];

type MapState =
  { readonly status: "loading" | "empty" | "error" } | { readonly status: "ready"; readonly model: MapModel };

/** `start` a new job, plan a `route` without mowing, or `modify` the running job. */
type PlanKind = "start" | "route" | "modify";

/** What the user was shown when asked to confirm; exactly this is sent. */
interface Plan {
  readonly mower: Mower;
  readonly data: Record<string, unknown>;
  readonly summary: string;
  readonly kind: PlanKind;
}

type Request =
  | { readonly status: "idle" }
  | { readonly status: "confirming"; readonly plan: Plan; readonly armed: boolean }
  | { readonly status: "sending" | "sent" | "failed"; readonly plan: Plan };

type RouteState =
  | { readonly status: "idle" | "loading" | "unavailable" }
  | { readonly status: "ready"; readonly lines: readonly (readonly Point[])[] };

const IDLE = { status: "idle" } as const;
const KNOWN_STATES = ["mowing", "paused", "returning", "docked", "idle", "error"] as const;
const ACTIVE_STATES: readonly string[] = ["mowing", "paused", "returning"];
const OFFLINE_STATES: readonly string[] = ["unavailable", "unknown"];
const ROUTE_POLL_MS = 2000;
const ROUTE_POLLS = 10;
/** Keeps a double tap on Start from also confirming it. */
const CONFIRM_ARM_MS = 600;

const PLAN_LABELS: Readonly<Record<PlanKind, { readonly title: StringKey; readonly confirm: StringKey }>> = {
  start: { title: "action.start", confirm: "action.confirm_start" },
  route: { title: "preview.exact_route", confirm: "action.confirm_route" },
  modify: { title: "action.apply", confirm: "action.confirm_apply" },
};

const SETTING_LABELS: Readonly<Record<SettingName, StringKey>> = {
  pattern: "settings.pattern",
  angleMode: "settings.angle",
  angle: "settings.angle_value",
  crossAngle: "settings.cross_angle",
  spacingCm: "settings.spacing",
  perimeterLaps: "settings.perimeter_laps",
  obstacleLaps: "settings.obstacle_laps",
  mowOrder: "settings.mow_order",
  speed: "settings.speed",
  bladeHeight: "settings.blade_height",
  edgeDistance: "settings.edge",
  obstacleDetection: "settings.detection",
  startProgress: "settings.start_progress",
  autoChangeDirection: "settings.auto_change_direction",
  cutGrass: "settings.cut_grass",
  dumpGrass: "settings.dump_grass",
  cutEdges: "settings.cut_edges",
  dumpInterval: "settings.dump_interval",
};

/** The switches name unnamed areas differently from the map; the switches are what the user knows. */
function withSwitchNames(model: MapModel, switches: readonly AreaSwitch[]): MapModel {
  const names = new Map(switches.map((area) => [area.hash, area.name]));
  return {
    ...model,
    areas: model.areas.map((zone) => ({ ...zone, name: names.get(zone.hash) ?? zone.name })),
  };
}

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
  @state() private edits: Partial<MowSettings> = {};
  @state() private map: MapState = { status: "loading" };
  @state() private previews: readonly AreaPreview[] = [];
  @state() private route: RouteState = IDLE;
  @state() private request: Request = IDLE;

  private latestHass?: HomeAssistant;
  private mowerSnapshot = "";
  private previewKey = "";
  private armTimer?: ReturnType<typeof setTimeout>;
  private latestMapLoad = 0;
  private hadFocus = false;
  private jobMode = false;
  private readonly loadedMaps = new Map<string, MapState>();

  setConfig(config: unknown): void {
    this.config = normalizeConfig(config);
    this.syncMower();
  }

  set hass(hass: HomeAssistant) {
    this.latestHass = hass;
    this.language = hass.language;
    this.dir = isRtl(hass) ? "rtl" : "ltr";
    this.syncMower();
  }

  getCardSize(): number {
    return 10;
  }

  getGridOptions(): Record<string, number | string> {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.armTimer);
    if (this.request.status === "confirming") this.request = IDLE;
  }

  /** Re-reads the chosen mower, keeping the choice while that mower still exists. */
  private syncMower(): void {
    const hass = this.latestHass;
    if (!hass) return;
    const offered = this.config?.entities ?? findMowers(hass);
    if (offered.join() !== this.mowerIds.join()) this.mowerIds = offered;
    const known = this.mowerId && (offered.includes(this.mowerId) || this.mowerId in hass.entities);
    if (!known) this.mowerId = offered.find((id) => id in hass.states) ?? offered[0];
    const mower = this.mowerId ? readMower(hass, this.mowerId) : undefined;
    const snapshot = JSON.stringify(mower);
    if (snapshot !== this.mowerSnapshot) {
      this.mowerSnapshot = snapshot;
      this.mower = mower;
    }
  }

  private pickMower(mowerId: string): void {
    if (this.busy) return;
    this.mowerId = mowerId;
    this.syncMower();
  }

  private get settings(): MowSettings | undefined {
    return this.mower && { ...this.mower.settings, ...this.edits };
  }

  private get selectedAreas(): readonly AreaSwitch[] {
    const areas = this.mower?.areas ?? [];
    const hashes = this.job?.areas ?? this.pickedHashes;
    if (!hashes) return areas.filter((area) => area.on);
    return hashes.flatMap((hash) => areas.find((area) => area.hash === hash) ?? []);
  }

  private get busy(): boolean {
    return this.request.status === "sending" || this.route.status === "loading";
  }

  private get active(): boolean {
    return ACTIVE_STATES.includes(this.mower?.state ?? "");
  }

  private get job(): Mower["runningJob"] {
    return this.mower?.runningJob;
  }

  /** The edited settings the running job can take. */
  private get jobEdits(): SettingName[] {
    return (this.job?.changeable ?? []).filter((name) => name in this.edits);
  }

  private get lockedSettings(): readonly SettingName[] {
    const { job, settings } = this;
    if (!job || !settings) return [];
    return (Object.keys(settings) as SettingName[]).filter((name) => !job.changeable.includes(name));
  }

  /**
   * A running job is changed, never replaced, from the card; planning a route drops a paused job,
   * so a busy mower is never asked for one.
   */
  private refuses(kind: PlanKind): boolean {
    if (this.blocker) return true;
    if (kind === "modify") return !this.job || this.jobEdits.length === 0;
    return Boolean(this.job) || (kind === "route" && this.active);
  }

  private get pathLengthM(): number {
    return this.previews.reduce((sum, preview) => sum + preview.lengthM, 0);
  }

  private get blocker(): StringKey | undefined {
    const { mower, settings } = this;
    if (!mower || OFFLINE_STATES.includes(mower.state)) return "warn.unavailable";
    if (mower.runningJob) return undefined;
    if (this.selectedAreas.length === 0) return "warn.no_area";
    if (settings?.pattern !== "no_grid") return undefined;
    const nothingToMow = this.map.status === "ready" && this.pathLengthM === 0;
    return nothingToMow || settings.perimeterLaps + settings.obstacleLaps === 0 ? "warn.no_path" : undefined;
  }

  private t(key: StringKey, vars?: Record<string, string | number>): string {
    return localize(this.language, key, vars);
  }

  private num(value: number, maximumFractionDigits = 0): string {
    return new Intl.NumberFormat(this.language, { maximumFractionDigits }).format(value);
  }

  protected override willUpdate(changed: PropertyValues): void {
    this.hadFocus = this.matches(":focus-within");
    if (changed.has("mowerId")) this.resetPlan();
    const jobMode = Boolean(this.job);
    if (jobMode !== this.jobMode) {
      this.jobMode = jobMode;
      this.edits = {};
    }
    this.refreshPreviews();
    if (this.request.status === "confirming" && this.refuses(this.request.plan.kind)) this.cancelConfirm();
  }

  protected override updated(changed: PropertyValues): void {
    if (changed.has("mowerId")) void this.loadMap();
    if (changed.has("step") && this.getBoundingClientRect().top < 0) this.scrollIntoView({ block: "start" });
    const moved = changed.has("step") || changed.has("request");
    if (moved && this.hadFocus && !this.shadowRoot?.activeElement) {
      this.shadowRoot?.querySelector<HTMLElement>("[data-focus]")?.focus();
    }
  }

  private resetPlan(): void {
    this.step = "areas";
    this.pickedHashes = undefined;
    this.edits = {};
    this.forgetOutcome();
  }

  private forgetOutcome(): void {
    if (this.busy) return;
    this.cancelConfirm();
    this.route = IDLE;
    this.request = IDLE;
  }

  private refreshPreviews(): void {
    const { settings, map } = this;
    const hashes = this.selectedAreas.map((area) => area.hash);
    const offset = this.config?.angle_offset ?? 0;
    const model = map.status === "ready" ? map.model : undefined;
    const key = JSON.stringify([hashes, settings, offset, model?.origin, model?.bounds]);
    if (key === this.previewKey) return;
    this.previewKey = key;
    this.previews =
      model && settings
        ? hashes.flatMap((hash) => {
            const area = model.areas.find((zone) => zone.hash === hash);
            return area ? previewArea(area, model.obstacles, settings, offset) : [];
          })
        : [];
  }

  private async loadMap(refresh = false): Promise<void> {
    const { mowerId, latestHass: hass } = this;
    const areas = this.mower?.areas;
    if (!mowerId || !hass || !areas) return;
    const loaded = refresh ? undefined : this.loadedMaps.get(mowerId);
    if (loaded) {
      this.map = loaded;
      return;
    }
    const load = ++this.latestMapLoad;
    this.map = { status: "loading" };
    let map: MapState;
    try {
      const geojson = await fetchMap(hass, mowerId);
      const model = geojson && projectMap(geojson);
      map = model ? { status: "ready", model: withSwitchNames(model, areas) } : { status: "empty" };
    } catch {
      map = { status: "error" };
    }
    if (map.status === "ready") this.loadedMaps.set(mowerId, map);
    if (load === this.latestMapLoad) this.map = map;
  }

  private toggleArea(hash: number): void {
    if (this.busy || this.job || !this.mower?.areas.some((area) => area.hash === hash)) return;
    const hashes = this.selectedAreas.map((area) => area.hash);
    this.pickedHashes = hashes.includes(hash) ? hashes.filter((h) => h !== hash) : [...hashes, hash];
    this.forgetOutcome();
  }

  private toggleAll(): void {
    if (this.busy || this.job) return;
    const all = (this.mower?.areas ?? []).map((area) => area.hash);
    const picked = this.selectedAreas.map((area) => area.hash);
    this.pickedHashes =
      picked.length === all.length ? [] : [...picked, ...all.filter((hash) => !picked.includes(hash))];
    this.forgetOutcome();
  }

  /** Records only the fields that changed, so the rest keep following the mower. */
  private editSettings(settings: MowSettings): void {
    const { settings: shown, lockedSettings: locked } = this;
    if (this.busy || !shown) return;
    const changed = Object.entries(settings).filter(
      ([name, value]) => value !== shown[name as SettingName] && !locked.includes(name as SettingName),
    );
    this.edits = { ...this.edits, ...Object.fromEntries(changed) };
    this.forgetOutcome();
  }

  private goTo(step: Step): void {
    if (this.busy) return;
    this.step = step;
    if (this.request.status !== "sent") this.cancelConfirm();
  }

  private startOver(): void {
    this.request = IDLE;
    this.step = "areas";
  }

  /** The settings to send: those an entity holds, plus those changed in the card. */
  private get sentSettings(): SettingName[] {
    return [...new Set([...(this.mower?.heldSettings ?? []), ...(Object.keys(this.edits) as SettingName[])])];
  }

  private askToConfirm(kind: PlanKind): void {
    const { mower, settings, jobEdits } = this;
    if (!mower || !settings || this.busy || this.refuses(kind)) return;
    const areas = this.selectedAreas.map((area) => area.entityId);
    const plan: Plan =
      kind === "modify"
        ? {
            mower,
            kind,
            data: modifyJobData(settings, jobEdits),
            summary: jobEdits.map((name) => this.t(SETTING_LABELS[name])).join(", "),
          }
        : {
            mower,
            kind,
            data: startMowData(settings, this.sentSettings, areas, kind === "route"),
            summary: this.totals.join(" · "),
          };
    this.request = { status: "confirming", plan, armed: false };
    clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => {
      if (this.request.status === "confirming") this.request = { ...this.request, armed: true };
    }, CONFIRM_ARM_MS);
  }

  private cancelConfirm(): void {
    clearTimeout(this.armTimer);
    if (this.request.status === "confirming") this.request = IDLE;
  }

  private async sendConfirmed(): Promise<void> {
    const { latestHass: hass, request } = this;
    if (!hass || request.status !== "confirming" || !request.armed) return;
    const { plan } = request;
    if (this.refuses(plan.kind)) return;
    this.request = { status: "sending", plan };
    let sent = true;
    try {
      await (plan.kind === "modify" ? modifyRunningJob : startMow)(hass, plan.mower.entityId, plan.data);
    } catch {
      sent = false;
    }
    if (plan.kind === "route") {
      this.request = IDLE;
      if (sent) await this.loadRoute(hass, plan.mower.entityId);
      else this.route = { status: "unavailable" };
    } else {
      this.request = { status: sent ? "sent" : "failed", plan };
    }
  }

  private async loadRoute(hass: HomeAssistant, mowerId: string): Promise<void> {
    if (this.map.status !== "ready") return;
    const { origin } = this.map.model;
    const loading: RouteState = { status: "loading" };
    this.route = loading;
    let route: RouteState = { status: "unavailable" };
    try {
      await requestPlannedRoute(hass, mowerId);
      for (let poll = 0; poll < ROUTE_POLLS && this.route === loading && this.isConnected; poll++) {
        await wait(ROUTE_POLL_MS);
        const geojson = await fetchPlannedRoute(hass, mowerId);
        const lines = geojson?.features.flatMap(({ geometry }) =>
          geometry.type === "LineString"
            ? [geometry.coordinates.map(([lon = 0, lat = 0]) => projectPosition(origin, lon, lat))]
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
      everyNthPass: (n) => this.t("map.thinned", { n }),
      area: ({ name, areaM2, order }) =>
        [
          this.t("map.area_label", { name, size: this.num(areaM2) }),
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

  private get duration(): string | undefined {
    const speed = this.settings?.speed ?? 0;
    if (this.pathLengthM <= 0 || speed <= 0) return undefined;
    const total = Math.max(1, Math.round(this.pathLengthM / speed / 60));
    const [hours, minutes] = [Math.floor(total / 60), total % 60];
    return hours > 0
      ? this.t("summary.duration_hours", { hours, minutes })
      : this.t("summary.duration", { minutes });
  }

  /** How many settings the running job would change. */
  private get jobTotals(): string[] {
    const count = this.jobEdits.length;
    if (count === 0) return [this.t("job.no_changes")];
    return [count === 1 ? this.t("job.change_one") : this.t("job.changes", { count })];
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
      selected.length === 1
        ? this.t("summary.area_one")
        : this.t("summary.areas", { count: selected.length }),
      ...(size > 0 ? [this.t("summary.area_size", { size: this.num(size) })] : []),
      ...(this.duration ? [this.duration] : []),
    ];
  }

  protected override render(): TemplateResult {
    const { mower } = this;
    if (!mower) {
      return html`
        <ha-card>
          ${this.mowerIds.length > 1 ? html`<header>${this.renderMowerPicker()}</header>` : nothing}
          <p class="message" role="status">${this.t("mower.none")}</p>
        </ha-card>
      `;
    }
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

  private renderIcon(path: string, kind = ""): TemplateResult {
    return html`<svg class="icon ${kind}" viewBox="0 0 24 24" aria-hidden="true">${mdiIcon(path)}</svg>`;
  }

  private renderHeader(mower: Mower): TemplateResult {
    const known = KNOWN_STATES.find((name) => name === mower.state);
    const title = this.config?.title ?? (this.mowerIds.length < 2 ? mower.name : undefined);
    return html`
      <header>
        <div class="title">
          ${title ? html`<h2>${title}</h2>` : nothing}
          ${this.mowerIds.length > 1 ? this.renderMowerPicker() : nothing}
          <span class="secondary">
            ${this.t(known ? `state.${known}` : "state.unavailable")}
            ${
              mower.battery === undefined
                ? nothing
                : html` · ${this.renderIcon(mdiBattery, "inline")}
                  ${this.t("mower.battery", { percent: this.num(mower.battery) })}`
            }
          </span>
        </div>
        <button
          class="icon-button"
          aria-label=${this.t("map.refresh")}
          title=${this.t("map.refresh")}
          ?disabled=${this.map.status === "loading" || this.busy}
          @click=${() => void this.loadMap(true)}
        >
          ${this.renderIcon(mdiRefresh)}
        </button>
      </header>
    `;
  }

  private renderMowerPicker(): TemplateResult {
    const hass = this.latestHass;
    return html`
      <select
        aria-label=${this.t("mower.pick")}
        ?disabled=${this.busy}
        @change=${(event: Event) => {
          this.pickMower((event.target as HTMLSelectElement).value);
        }}
      >
        ${this.mowerIds.map(
          (id) =>
            html`<option value=${id} ?selected=${id === this.mowerId}>
              ${hass ? mowerName(hass, id) : id}
            </option>`,
        )}
      </select>
    `;
  }

  private renderMap(): TemplateResult {
    const { map } = this;
    if (map.status !== "ready") {
      return html`
        <div class="map vacant" role="status">
          ${map.status === "loading" ? nothing : this.renderIcon(mdiMapMarkerOffOutline)}
          <p>
            ${this.t(
              map.status === "loading"
                ? "map.loading"
                : map.status === "empty"
                  ? "map.unavailable"
                  : "map.error",
            )}
          </p>
          ${
            map.status === "loading"
              ? nothing
              : html`<button class="text-button" @click=${() => void this.loadMap(true)}>
                  ${this.t("map.retry")}
                </button>`
          }
        </div>
      `;
    }
    const approximate = this.route.status !== "ready" && this.previews.some((p) => !p.directionExact);
    return html`
      <div class="map">
        <mow-planner-map
          .model=${map.model}
          .selected=${this.selectedAreas.map((area) => area.hash)}
          .previews=${this.previews}
          .mower=${this.mowerMarker}
          .route=${this.route.status === "ready" ? this.route.lines : undefined}
          .strings=${this.mapStrings}
          .note=${approximate ? this.t("preview.approximate") : undefined}
          ?readonly=${this.step === "review" || this.busy || Boolean(this.job)}
          @area-toggle=${(event: CustomEvent<{ hash: number }>) => {
            this.toggleArea(event.detail.hash);
          }}
        ></mow-planner-map>
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
                  ?disabled=${this.busy}
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
    const { job } = this;
    return html`${
        job
          ? html`<p class="secondary hint" role="note">
              ${this.t(job.changeable.length > 0 ? "job.locked" : "job.unsupported", { name: mower.name })}
            </p>`
          : nothing
      }
      <mow-planner-settings
        .settings=${this.settings}
        .limits=${mower.limits}
        .language=${this.language}
        .disabled=${this.busy}
        .locked=${this.lockedSettings}
        @settings-changed=${(event: CustomEvent<{ settings: MowSettings }>) => {
          this.editSettings(event.detail.settings);
        }}
      ></mow-planner-settings>`;
  }

  private renderAreas(mower: Mower): TemplateResult {
    if (mower.areas.length === 0) return html`<p class="secondary">${this.t("areas.none_available")}</p>`;
    const selected = this.selectedAreas;
    const locked = this.busy || Boolean(this.job);
    const hint = this.job ? "areas.locked" : this.map.status === "ready" ? "areas.hint" : "areas.hint_list";
    return html`
      <p class="secondary hint">${this.t(hint)}</p>
      <div class="chips">
        <button
          class="chip"
          aria-pressed=${selected.length === mower.areas.length}
          ?disabled=${locked}
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
              ?disabled=${locked}
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
    const degrees = (value: number) => this.t("unit.degrees", { value: this.num(value) });
    const detection = mower.limits.obstacleDetection?.find(
      (option) => option.code === settings.obstacleDetection,
    );
    const onOff = (name: SettingName) =>
      [this.t(SETTING_LABELS[name]), this.t(settings[name] ? "toggle.on" : "toggle.off")] as const;
    const angle =
      settings.angleMode === "random_angle"
        ? this.t("angle_mode.random_angle")
        : `${this.t(`angle_mode.${settings.angleMode}`)}, ${degrees(settings.angle)}`;
    const rows: (readonly [string, string] | false | undefined)[] = [
      [this.t("step.areas"), this.selectedAreas.map((area) => area.name).join(", ")],
      [this.t("settings.pattern"), this.t(`pattern.${settings.pattern}`)],
      striped && [this.t("settings.angle"), angle],
      settings.pattern === "double_grid" && [this.t("settings.cross_angle"), degrees(settings.crossAngle)],
      [this.t("settings.spacing"), this.t("unit.cm", { value: this.num(settings.spacingCm) })],
      [this.t("settings.perimeter_laps"), this.num(settings.perimeterLaps)],
      [this.t("settings.obstacle_laps"), this.num(settings.obstacleLaps)],
      striped && [this.t("settings.mow_order"), this.t(`mow_order.${settings.mowOrder}`)],
      [this.t("settings.speed"), this.t("unit.speed", { value: this.num(settings.speed, 1) })],
      settings.bladeHeight !== undefined && [
        this.t("settings.blade_height"),
        this.t("unit.mm", { value: this.num(settings.bladeHeight) }),
      ],
      settings.edgeDistance !== undefined && [
        this.t("settings.edge"),
        this.t(settings.edgeDistance < 0.25 ? "edge.inside" : "edge.on"),
      ],
      detection && [this.t("settings.detection"), this.t(`detection.${detection.key}`)],
      settings.startProgress !== undefined && [
        this.t("settings.start_progress"),
        this.t("unit.percent", { value: this.num(settings.startProgress) }),
      ],
      ...(mower.limits.switches ?? []).map(onOff),
      settings.dumpInterval !== undefined &&
        settings.dumpGrass !== false && [
          this.t("settings.dump_interval"),
          this.t("unit.m2", { value: this.num(settings.dumpInterval) }),
        ],
      this.pathLengthM > 0 && [
        this.t("review.distance"),
        this.t("summary.distance", { km: this.num(this.pathLengthM / 1000, 1) }),
      ],
      this.duration !== undefined && [this.t("review.estimate"), this.duration],
    ];
    const canFetchRoute =
      this.config?.exact_route &&
      this.map.status === "ready" &&
      !this.blocker &&
      !ACTIVE_STATES.includes(mower.state) &&
      this.request.status === "idle";
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
              ?disabled=${this.busy}
              @click=${() => {
                this.askToConfirm("route");
              }}
            >
              ${this.t(this.route.status === "loading" ? "preview.exact_route_loading" : "preview.exact_route")}
            </button>`
          : nothing
      }
      ${
        this.route.status === "unavailable"
          ? html`<p class="secondary" role="status">${this.t("preview.exact_route_unavailable")}</p>`
          : nothing
      }
    `;
  }

  private renderAlert(kind: "warning" | "error" | "success", key: StringKey, mower: Mower): TemplateResult {
    return html`
      <p class="alert ${kind}" role=${kind === "error" ? "alert" : "status"}>
        ${this.renderIcon(kind === "success" ? mdiCheckCircleOutline : mdiAlertOutline)}
        ${this.t(key, { name: mower.name })}
      </p>
    `;
  }

  private renderConfirm({ plan, armed }: Extract<Request, { status: "confirming" }>): TemplateResult {
    const { mower, kind, summary } = plan;
    const { name } = mower;
    return html`
      <footer
        class="confirm"
        role="alertdialog"
        aria-label=${this.t(PLAN_LABELS[kind].title)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") this.cancelConfirm();
        }}
      >
        <p>
          ${
            kind === "route"
              ? this.t("route.confirm", { name })
              : kind === "modify"
                ? this.t("modify.confirm", { name, changes: summary })
                : this.t("start.confirm", { name, areas: summary })
          }
        </p>
        ${kind === "start" && this.active ? this.renderAlert("warning", "warn.active_job", mower) : nothing}
        <div class="actions">
          <button
            class="text-button"
            data-focus
            @click=${() => {
              this.cancelConfirm();
            }}
          >
            ${this.t("action.cancel")}
          </button>
          <button class="primary" ?disabled=${!armed} @click=${() => void this.sendConfirmed()}>
            ${this.t(PLAN_LABELS[kind].confirm)}
          </button>
        </div>
      </footer>
    `;
  }

  private renderFooter(mower: Mower): TemplateResult {
    const { blocker, step, request } = this;
    if (request.status === "confirming") return this.renderConfirm(request);
    const outcome =
      step === "review" && request.status !== "idle" && request.plan.mower.entityId === mower.entityId;
    const next = STEPS[STEPS.indexOf(step) + 1];
    const back = STEPS[STEPS.indexOf(step) - 1];
    const blocked = blocker && (step !== "areas" || blocker === "warn.unavailable");
    const modified = outcome && request.plan.kind === "modify";
    return html`
      <footer>
        ${
          outcome && request.status === "sent"
            ? this.renderAlert("success", modified ? "modify.sent" : "start.sent", mower)
            : nothing
        }
        ${
          outcome && request.status === "failed"
            ? this.renderAlert("error", modified ? "modify.failed" : "start.failed", mower)
            : nothing
        }
        ${blocked ? this.renderAlert("error", blocker, mower) : nothing}
        ${
          step === "review" && !blocker && request.status === "idle" && this.active && !this.job
            ? this.renderAlert("warning", "warn.active_job", mower)
            : nothing
        }
        <div class="actions">
          <span class="secondary totals" aria-live="polite">
            ${
              step === "areas" && blocker === "warn.no_area"
                ? this.t("warn.no_area")
                : (this.job ? this.jobTotals : this.totals).map(
                    (phrase, index) => html`${index ? " · " : nothing}<bdi>${phrase}</bdi>`,
                  )
            }
          </span>
          ${
            back
              ? html`<button
                  class="text-button"
                  ?disabled=${this.busy}
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
                  data-focus
                  ?disabled=${
                    step === "areas"
                      ? !this.job && this.selectedAreas.length === 0
                      : blocker === "warn.no_path"
                  }
                  @click=${() => {
                    this.goTo(next);
                  }}
                >
                  ${this.t("action.next")}
                </button>`
              : outcome && request.status === "sent" && !modified
                ? html`<button
                    class="primary"
                    data-focus
                    @click=${() => {
                      this.startOver();
                    }}
                  >
                    ${this.t("action.new_plan")}
                  </button>`
                : this.job
                  ? html`<button
                      class="primary"
                      data-focus
                      ?disabled=${
                        Boolean(blocker) ||
                        this.busy ||
                        request.status === "sent" ||
                        this.jobEdits.length === 0
                      }
                      @click=${() => {
                        this.askToConfirm("modify");
                      }}
                    >
                      ${this.renderIcon(mdiCheck)}
                      ${this.t(request.status === "sending" ? "action.applying" : "action.apply")}
                    </button>`
                  : html`<button
                      class="primary"
                      data-focus
                      ?disabled=${Boolean(blocker) || this.busy}
                      @click=${() => {
                        this.askToConfirm("start");
                      }}
                    >
                      ${this.renderIcon(mdiPlay)}
                      ${this.t(request.status === "sending" ? "action.starting" : "action.start")}
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
        padding-block: 12px 8px;
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
      mow-planner-map {
        height: 100%;
      }
      .map.vacant {
        position: static;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        height: auto;
        min-height: 120px;
        padding: 16px;
        color: var(--secondary-text-color, #727272);
      }
      .message,
      .vacant p {
        margin: 0;
        text-align: center;
        color: var(--secondary-text-color, #727272);
      }
      .message {
        padding: 32px 16px;
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
      .step:hover:not(:disabled) {
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
        flex-wrap: wrap;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
      }
      .totals {
        flex: 1 1 100%;
        min-width: 0;
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
      @container (min-width: 440px) {
        .totals {
          flex-basis: 0;
        }
      }
      @container (min-width: 720px) {
        .layout {
          display: grid;
          grid-template-columns: minmax(0, 1.2fr) minmax(300px, 1fr);
          align-items: start;
        }
        .map {
          height: 460px;
          border-end-start-radius: var(--ha-card-border-radius, 12px);
        }
        .map.vacant {
          height: 460px;
        }
      }
    `,
  ];
}

defineOnce(CARD_TYPE, MowPlannerCard);

declare global {
  interface Window {
    customCards?: { type: string; name: string; description: string }[];
  }
}

window.customCards ??= [];
if (!window.customCards.some((card) => card.type === CARD_TYPE)) {
  window.customCards.push({
    type: CARD_TYPE,
    name: "Mammotion Mow Planner",
    description: "Pick areas on the map, preview the mowing pattern and start the job.",
  });
}
