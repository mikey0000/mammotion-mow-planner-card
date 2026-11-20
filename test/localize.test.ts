import { describe, expect, it } from "vitest";
import type { HomeAssistant } from "../src/ha/types";
import { isRtl, localize, type StringKey } from "../src/localize";
import { en } from "../src/translations/en";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const german = (key: StringKey) => localize("de", key);

describe("localize", () => {
  it("looks up English strings", () => {
    expect(localize("en", "action.start")).toBe("Start mowing");
  });

  it("replaces placeholders", () => {
    expect(localize("en", "start.sent", { name: "Luba" })).toBe("Mowing job sent to Luba");
    expect(localize("en", "map.area_label", { name: "Front", size: 120 })).toBe("Front, 120 m²");
  });

  it("looks up German strings", () => {
    expect(localize("de", "action.start")).not.toBe(localize("en", "action.start"));
    expect(localize("de", "action.start")).toBe("Mähen starten");
  });

  it("falls back from a regional language to its base language", () => {
    expect(localize("de-AT", "action.start")).toBe(german("action.start"));
  });

  it("falls back to English for unknown or missing languages", () => {
    expect(localize("xx", "action.start")).toBe("Start mowing");
    expect(localize(undefined, "action.start")).toBe("Start mowing");
  });

  it("names patterns and mow order like the app", () => {
    const names = (language: string) =>
      (
        ["pattern.single_grid", "pattern.double_grid", "pattern.segment_grid", "pattern.no_grid"] as const
      ).map((key) => localize(language, key));
    expect(names("en")).toEqual(["Stripes", "Grid", "Adaptive", "Perimeter"]);
    expect(names("de")).toEqual(["Streifen", "Gitter", "Adaptiv", "Rand"]);
    expect(localize("en", "mow_order.grid_first")).toBe("Inside");
    expect(localize("en", "mow_order.border_first")).toBe("Perimeter");
    expect(localize("de", "mow_order.grid_first")).toBe("Innen");
  });

  it("has the card shell strings", () => {
    expect(localize("en", "summary.duration_hours", { hours: 1, minutes: 5 })).toBe("about 1 h 5 min");
    expect(localize("de", "summary.duration_hours", { hours: 1, minutes: 5 })).toBe("etwa 1 h 5 min");
    expect(localize("en", "review.estimate")).toBe("Estimated time");
    expect(localize("en", "review.distance")).toBe("Path length");
    expect(localize("en", "step.label")).toBe("Steps");
    for (const key of ["review.estimate", "review.distance", "step.label"] as const) {
      expect(german(key), key).not.toBe(localize("en", key));
    }
  });

  it("has every English key in German, non-empty, with the same placeholders", () => {
    for (const key of Object.keys(en) as StringKey[]) {
      expect(german(key), key).not.toBe("");
      expect(placeholders(german(key)), key).toEqual(placeholders(en[key]));
    }
  });
});

describe("isRtl", () => {
  const hass = (language: string, translations?: Record<string, { isRTL?: boolean }>) =>
    ({ language, translationMetadata: translations && { translations } }) as unknown as HomeAssistant;

  it("reads the RTL flag of the current language", () => {
    expect(isRtl(hass("he", { he: { isRTL: true }, en: {} }))).toBe(true);
    expect(isRtl(hass("en", { he: { isRTL: true }, en: {} }))).toBe(false);
  });

  it("is false without translation metadata", () => {
    expect(isRtl(hass("he"))).toBe(false);
  });
});
