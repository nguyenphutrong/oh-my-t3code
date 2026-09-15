import { describe, expect, it } from "vite-plus/test";

import {
  deriveAvailableInstanceId,
  isConfiguredAcpRegistryAgent,
  resolveWizardNavigation,
} from "./AddProviderInstanceDialog.logic";

describe("ACP Registry provider identity", () => {
  const derive = (label: string) => `acpRegistry_${label.toLowerCase().replaceAll(" ", "_")}`;

  it("chooses a stable unused instance id without colliding with existing agents", () => {
    expect(
      deriveAvailableInstanceId(
        derive,
        "Amp ACP",
        new Set(["acpRegistry_amp_acp", "acpRegistry_amp_acp_2"]),
      ),
    ).toBe("acpRegistry_amp_acp_3");
  });

  it("only treats the same ACP agent id as already configured", () => {
    const instances = {
      cursor: { driver: "cursor", config: { agentId: "amp-acp" } },
      acp: { driver: "acpRegistry", config: { agentId: "other-agent" } },
    };
    expect(isConfiguredAcpRegistryAgent(instances, "amp-acp")).toBe(false);
    expect(isConfiguredAcpRegistryAgent(instances, "other-agent")).toBe(true);
  });
});

describe("resolveWizardNavigation", () => {
  const invalidId = { instanceIdError: "Instance ID is required." };
  const validId = { instanceIdError: null };

  it("allows moving from Driver to Identity before the instance id is valid", () => {
    expect(resolveWizardNavigation(0, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
  });

  it("blocks Next from Identity to Config while the instance id is invalid", () => {
    expect(resolveWizardNavigation(1, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("stops a direct Driver-to-Config skip at Identity and surfaces its error", () => {
    expect(resolveWizardNavigation(0, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("allows advancing and skipping forward once the instance id is valid", () => {
    expect(resolveWizardNavigation(1, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
  });

  it("always preserves backward Driver and Identity navigation", () => {
    expect(resolveWizardNavigation(2, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
    expect(resolveWizardNavigation(2, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
    expect(resolveWizardNavigation(1, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });

  it("clamps requested steps to the wizard bounds", () => {
    expect(resolveWizardNavigation(2, 8, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, -1, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });
});
