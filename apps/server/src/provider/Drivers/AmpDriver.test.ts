import { describe, expect, it } from "@effect/vitest";

import { AMP_MODELS } from "../Layers/AmpProvider.ts";
import { AmpDriver } from "./AmpDriver.ts";

describe("AmpDriver", () => {
  it("registers Amp as an opt-in multi-instance provider", () => {
    expect(AmpDriver.driverKind).toBe("amp");
    expect(AmpDriver.metadata).toEqual({
      displayName: "Amp",
      supportsMultipleInstances: true,
    });
    expect(AmpDriver.defaultConfig()).toEqual({
      enabled: false,
      binaryPath: "amp",
      settingsFile: "",
    });
  });

  it("advertises official Amp modes and reasoning effort", () => {
    expect(AMP_MODELS.map(({ slug }) => slug)).toEqual(["low", "medium", "high", "ultra"]);
    expect(AMP_MODELS.find(({ isDefault }) => isDefault)?.slug).toBe("medium");
    expect(AMP_MODELS[0]?.capabilities?.optionDescriptors).toMatchObject([
      {
        id: "reasoningEffort",
        type: "select",
        currentValue: "medium",
        options: expect.arrayContaining([
          expect.objectContaining({ id: "none" }),
          expect.objectContaining({ id: "xhigh" }),
          expect.objectContaining({ id: "max" }),
        ]),
      },
      {
        id: "fastMode",
        type: "boolean",
        currentValue: false,
      },
    ]);
  });
});
