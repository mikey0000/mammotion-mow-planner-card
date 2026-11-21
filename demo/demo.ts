import "../src/index";
import { CARD_TYPE } from "../src/config";
import type { HomeAssistant } from "../src/ha/types";
import { demoHass, type DemoOptions, type ServiceCall } from "./fixtures";

interface CardElement extends HTMLElement {
  hass: HomeAssistant;
  setConfig(config: unknown): void;
}

declare global {
  interface Window {
    /** Every service call the card made, for inspection by browser tests. */
    demoCalls: ServiceCall[];
  }
}

/** Stands in for Home Assistant's own card element, which only exists inside HA. */
class DemoCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = `<style>
      :host {
        display: block;
        background: var(--card-background-color);
        border: 1px solid var(--divider-color);
        border-radius: 12px;
      }
    </style><slot></slot>`;
  }
}
if (!customElements.get("ha-card")) customElements.define("ha-card", DemoCard);

const params = new URLSearchParams(location.search);
const dark = params.has("dark");
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dir = params.get("lang") === "he" ? "rtl" : "ltr";

window.demoCalls = [];
const log = document.querySelector("#log ol");
const options: DemoOptions = {
  darkMode: dark,
  language: params.get("lang") ?? "en",
  map: (params.get("map") as DemoOptions["map"]) ?? "ready",
  singleMower: params.has("single"),
  legacy: params.has("legacy"),
  onCall: (call) => {
    window.demoCalls.push(call);
    const item = document.createElement("li");
    item.textContent = `${call.domain}.${call.service} → ${JSON.stringify(call.target)} ${JSON.stringify(call.data)}`;
    log?.append(item);
  },
};

const tile = document.createElement("ha-card");
tile.innerHTML = `<div class="tile"><i></i><div><b>Living room</b><span>21.5 °C · stock tile for comparison</span></div></div>`;

const card = document.createElement(CARD_TYPE) as CardElement;
card.setConfig({
  type: `custom:${CARD_TYPE}`,
  ...(params.has("offset") && { angle_offset: Number(params.get("offset")) }),
  ...(params.has("route") && { exact_route: true }),
});
card.hass = demoHass(options);
document.querySelector("#dashboard")?.append(tile, card);
