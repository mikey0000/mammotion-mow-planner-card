import { describe, expect, it } from "vitest";
import { CARD_TYPE, configForm, normalizeConfig, stubConfig } from "../src/config";

const TYPE = `custom:${CARD_TYPE}`;

describe("normalizeConfig", () => {
  it("accepts a full config", () => {
    const config = {
      type: TYPE,
      entities: ["lawn_mower.luba", "lawn_mower.yuka"],
      title: "Mow",
      angle_offset: -12.5,
      exact_route: true,
    };

    expect(normalizeConfig(config)).toEqual(config);
  });

  it("accepts a bare config", () => {
    expect(normalizeConfig({ type: TYPE })).toEqual({ type: TYPE });
  });

  it("folds a single entity into entities", () => {
    expect(normalizeConfig({ type: TYPE, entity: "lawn_mower.luba" })).toEqual({
      type: TYPE,
      entities: ["lawn_mower.luba"],
    });
    expect(
      normalizeConfig({
        type: TYPE,
        entity: "lawn_mower.luba",
        entities: ["lawn_mower.yuka", "lawn_mower.luba"],
      }),
    ).toEqual({ type: TYPE, entities: ["lawn_mower.yuka", "lawn_mower.luba"] });
  });

  it("drops unknown keys", () => {
    expect(normalizeConfig({ type: TYPE, future_option: 1, view_layout: {} })).toEqual({ type: TYPE });
  });

  it.each([
    [null, /object/],
    ["text", /object/],
    [[], /object/],
    [{ type: TYPE, entities: "lawn_mower.luba" }, /"entities"/],
    [{ type: TYPE, entities: ["switch.luba"] }, /"entities".*switch\.luba/],
    [{ type: TYPE, entities: [3] }, /"entities"/],
    [{ type: TYPE, entity: "sensor.x" }, /"entity"/],
    [{ type: TYPE, title: 5 }, /"title"/],
    [{ type: TYPE, angle_offset: "10" }, /"angle_offset"/],
    [{ type: TYPE, angle_offset: 181 }, /"angle_offset"/],
    [{ type: TYPE, angle_offset: Number.NaN }, /"angle_offset"/],
    [{ type: TYPE, exact_route: "yes" }, /"exact_route"/],
  ])("rejects %j naming the offending key", (config, message) => {
    expect(() => normalizeConfig(config)).toThrow(message);
  });
});

describe("stubConfig", () => {
  it("relies on auto-discovery", () => {
    expect(stubConfig()).toEqual({ type: TYPE });
  });
});

describe("configForm", () => {
  const names = configForm.schema.map((field) => field.name);

  it("offers every option of the card config", () => {
    expect(names).toEqual(["entities", "title", "angle_offset", "exact_route"]);
    const config = {
      type: TYPE,
      entities: ["lawn_mower.a"],
      title: "t",
      angle_offset: 1,
      exact_route: false,
    };
    expect(Object.keys(normalizeConfig(config)).filter((key) => key !== "type")).toEqual(names);
  });

  it("limits the mower picker to Mammotion lawn mowers", () => {
    expect(configForm.schema[0]).toEqual({
      name: "entities",
      selector: { entity: { multiple: true, filter: { integration: "mammotion", domain: "lawn_mower" } } },
    });
  });

  it.each(["entities", "title", "angle_offset", "exact_route"])("labels and explains %s", (name) => {
    expect(configForm.computeLabel({ name })).toMatch(/\w/);
    expect(configForm.computeHelper({ name })).toMatch(/\w.*\.$/);
  });
});
