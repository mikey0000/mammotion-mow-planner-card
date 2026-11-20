import type { HomeAssistant } from "./ha/types";
import { de } from "./translations/de";
import { en } from "./translations/en";

export type StringKey = keyof typeof en;

const tables: Readonly<Record<string, Partial<Record<StringKey, string>>>> = { en, de };

export function localize(
  language: string | undefined,
  key: StringKey,
  vars: Record<string, string | number> = {},
): string {
  const base = language?.split("-")[0] ?? "";
  const text = tables[language ?? ""]?.[key] ?? tables[base]?.[key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match));
}

export function isRtl(hass: HomeAssistant): boolean {
  return hass.translationMetadata?.translations[hass.language]?.isRTL ?? false;
}
