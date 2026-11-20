export interface CardConfig {
  readonly type: string;
  /** Mowers to offer; every Mammotion mower when omitted. */
  readonly entities?: readonly string[];
  readonly title?: string;
  /** Degrees added to absolute path angles, to line the preview up with the map. */
  readonly angle_offset?: number;
  /** Offer fetching the mower's own planned route in the review step. */
  readonly exact_route?: boolean;
}

export const CARD_TYPE = "mammotion-mow-planner-card";

const isMower = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("lawn_mower.");

function mowerList(entities: unknown, entity: unknown): string[] | undefined {
  if (entity !== undefined && !isMower(entity)) {
    throw new Error(`"entity" must be a lawn_mower entity id, got ${JSON.stringify(entity)}.`);
  }
  if (entities !== undefined && !Array.isArray(entities)) {
    throw new Error(`"entities" must be a list of lawn_mower entity ids.`);
  }
  const list: unknown[] = entities ?? [];
  const invalid = list.find((id) => !isMower(id));
  if (invalid !== undefined) {
    throw new Error(`"entities" may only contain lawn_mower entity ids, got ${JSON.stringify(invalid)}.`);
  }
  const ids = [...list, entity].filter(isMower);
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

/** Validates what Lovelace hands to `setConfig`; unknown keys are dropped so newer options don't break. */
export function normalizeConfig(config: unknown): CardConfig {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("The card configuration must be an object.");
  }
  const { type, entities, entity, title, angle_offset, exact_route } = config as Record<string, unknown>;
  const mowers = mowerList(entities, entity);
  if (title !== undefined && typeof title !== "string") throw new Error(`"title" must be text.`);
  if (
    angle_offset !== undefined &&
    (typeof angle_offset !== "number" || !Number.isFinite(angle_offset) || Math.abs(angle_offset) > 180)
  ) {
    throw new Error(`"angle_offset" must be a number of degrees between -180 and 180.`);
  }
  if (exact_route !== undefined && typeof exact_route !== "boolean") {
    throw new Error(`"exact_route" must be true or false.`);
  }
  return {
    type: typeof type === "string" ? type : `custom:${CARD_TYPE}`,
    ...(mowers && { entities: mowers }),
    ...(title !== undefined && { title }),
    ...(angle_offset !== undefined && { angle_offset }),
    ...(exact_route !== undefined && { exact_route }),
  };
}

export function stubConfig(): CardConfig {
  return { type: `custom:${CARD_TYPE}` };
}

type OptionName = Exclude<keyof CardConfig, "type">;

const OPTION_TEXT: Readonly<Record<OptionName, { readonly label: string; readonly helper: string }>> = {
  entities: {
    label: "Mowers",
    helper: "Mowers to offer in the card; leave empty to offer every Mammotion mower.",
  },
  title: { label: "Title", helper: "Heading shown at the top of the card." },
  angle_offset: {
    label: "Angle offset",
    helper:
      "Degrees added to custom path angles in the preview, to line the stripes up with the map when the mower's map is rotated from north.",
  },
  exact_route: {
    label: "Exact route",
    helper: "Offer fetching the route planned by the mower itself before starting.",
  },
};

const text = (name: string) =>
  OPTION_TEXT[name as OptionName] as (typeof OPTION_TEXT)[OptionName] | undefined;

/** What `static getConfigForm()` returns for HA's built-in card editor. */
export const configForm = {
  schema: [
    {
      name: "entities",
      selector: { entity: { multiple: true, filter: { integration: "mammotion", domain: "lawn_mower" } } },
    },
    { name: "title", selector: { text: {} } },
    {
      name: "angle_offset",
      selector: { number: { min: -180, max: 180, step: 1, unit_of_measurement: "°", mode: "box" } },
    },
    { name: "exact_route", selector: { boolean: {} } },
  ] satisfies readonly { name: OptionName; selector: object }[],
  computeLabel: (schema: { readonly name: string }): string => text(schema.name)?.label ?? schema.name,
  computeHelper: (schema: { readonly name: string }): string => text(schema.name)?.helper ?? "",
};
