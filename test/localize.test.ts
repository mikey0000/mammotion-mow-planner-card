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
