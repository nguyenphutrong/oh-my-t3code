"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type AcpRegistrySearchAgent,
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Button } from "../ui/button";
import { Gemini, GithubCopilotIcon, PiAgentIcon, type Icon } from "../Icons";
import { Dialog } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { WizardPanel, WizardPopup, WizardHeader, WizardFooter } from "../ui/wizard";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  deriveAvailableInstanceId,
  resolveWizardNavigation,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { AcpRegistrySearchStep } from "./AcpRegistrySearchStep";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

/**
 * Normalize a user-provided label into a slug suffix for the instance id.
 * The full id is formed by prefixing the driver slug — e.g. label "Work" on
 * driver "codex" becomes `codex_work`. Output is trimmed to 48 chars so the
 * final composed id stays under the 64-char slug cap enforced by
 * `ProviderInstanceId` in `@t3tools/contracts`.
 */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function deriveInstanceId(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const DEFAULT_DRIVER_OPTION = DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
type EnvironmentVariableDraft = ProviderInstanceEnvironmentVariable & { readonly draftId: string };
let nextEnvironmentVariableDraftId = 0;

function makeEnvironmentVariableDraft(): EnvironmentVariableDraft {
  nextEnvironmentVariableDraftId += 1;
  return {
    draftId: `environment-variable-${nextEnvironmentVariableDraftId}`,
    name: "",
    value: "",
    sensitive: false,
  };
}

interface ComingSoonDriverOption {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
}

const COMING_SOON_DRIVER_OPTIONS: readonly ComingSoonDriverOption[] = [
  {
    value: ProviderDriverKind.make("githubCopilot"),
    label: "Github Copilot",
    icon: GithubCopilotIcon,
  },
  {
    value: ProviderDriverKind.make("gemini"),
    label: "Gemini",
    icon: Gemini,
  },
  {
    value: ProviderDriverKind.make("piAgent"),
    label: "Pi Agent",
    icon: PiAgentIcon,
  },
];

/**
 * Validate an instance id against the same slug rules the server applies in
 * `ProviderInstanceId` (see `packages/contracts/src/providerInstance.ts`).
 * Returns a user-facing error string, or `null` if valid.
 */
function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
}: AddProviderInstanceDialogProps) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  const [wizardStep, setWizardStep] = useState(0);
  const [driver, setDriver] = useState<ProviderDriverKind>(DEFAULT_DRIVER_KIND);
  const [label, setLabel] = useState("");
  const [accentColor, setAccentColor] = useState<string>("");
  const [instanceIdOverride, setInstanceIdOverride] = useState<string | null>(null);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [selectedAcp, setSelectedAcp] = useState<AcpRegistrySearchAgent | null>(null);
  const [manualAcpConfiguration, setManualAcpConfiguration] = useState(false);
  const [environmentVariables, setEnvironmentVariables] = useState<
    ReadonlyArray<EnvironmentVariableDraft>
  >([]);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const isAcpRegistry = driver === ACP_REGISTRY_DRIVER_KIND;
  const instanceId = instanceIdOverride ?? deriveInstanceId(driver, label);
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;
  const wizardStepSummaries = [driverOption.label, previewLabel, null] as const;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const configuredAgentId =
    typeof configDraft.agentId === "string" ? configDraft.agentId.trim() : "";
  const acpSelectionError =
    !isAcpRegistry || selectedAcp !== null || (manualAcpConfiguration && configuredAgentId)
      ? null
      : "Select an ACP Registry agent or choose manual configuration.";
  const environmentNames = environmentVariables.map((variable) => variable.name.trim());
  const environmentError = environmentVariables.some(
    (variable) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name.trim()),
  )
    ? "Environment variable names must use letters, digits, and underscores."
    : new Set(environmentNames).size !== environmentNames.length
      ? "Environment variable names must be unique."
      : null;
  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (config === undefined || Object.keys(config).length === 0) {
        delete next[driver];
      } else {
        next[driver] = config;
      }
      return next;
    });
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    if (wizardStep === 1 && requestedStep > 1 && acpSelectionError !== null) {
      setHasAttemptedSubmit(true);
      return;
    }
    applyWizardNavigation(
      resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
        instanceIdError,
      }),
    );
  };

  const handleAcpPrepared = (agent: AcpRegistrySearchAgent) => {
    const nextInstanceId = deriveAvailableInstanceId(
      (candidateLabel) => deriveInstanceId(ACP_REGISTRY_DRIVER_KIND, candidateLabel),
      agent.name,
      existingIds,
    );
    setSelectedAcp(agent);
    setManualAcpConfiguration(false);
    setLabel(agent.name);
    setInstanceIdOverride(nextInstanceId);
    setConfigByDriver((existing) => ({
      ...existing,
      [ACP_REGISTRY_DRIVER_KIND]: {
        agentId: agent.id,
        distribution: "auto",
      },
    }));
    setHasAttemptedSubmit(false);
  };

  const handleManualAcpConfiguration = () => {
    setSelectedAcp(null);
    setManualAcpConfiguration(true);
    setConfigByDriver((existing) => ({ ...existing, [ACP_REGISTRY_DRIVER_KIND]: {} }));
    setHasAttemptedSubmit(false);
  };

  const handleDriverChange = (value: string) => {
    setDriver(ProviderDriverKind.make(value));
    setLabel("");
    setAccentColor("");
    setInstanceIdOverride(null);
    setSelectedAcp(null);
    setManualAcpConfiguration(false);
    setEnvironmentVariables([]);
    setHasAttemptedSubmit(false);
  };

  const handleChooseAnotherAcp = () => {
    setSelectedAcp(null);
    setLabel("");
    setInstanceIdOverride(null);
    setConfigByDriver((existing) => {
      const next = { ...existing };
      delete next[ACP_REGISTRY_DRIVER_KIND];
      return next;
    });
    setHasAttemptedSubmit(false);
  };

  const handleSave = () => {
    setHasAttemptedSubmit(true);
    if (
      instanceIdError !== null ||
      acpSelectionError !== null ||
      (isAcpRegistry && environmentError !== null)
    )
      return;

    const config = configByDriver[driver] ?? {};
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(isAcpRegistry && environmentVariables.length > 0
        ? {
            environment: environmentVariables.map((variable) => ({
              name: variable.name,
              value: variable.value,
              sensitive: variable.sensitive,
              ...(variable.valueRedacted ? { valueRedacted: true } : {}),
            })),
          }
        : {}),
      ...(hasConfig ? { config } : {}),
    };
    // `ProviderInstanceId.make` revalidates the slug; we've already checked
    // it via `validateInstanceId`, but going through the brand constructor
    // keeps the type boundary honest and guards against any future drift in
    // the slug rules.
    const brandedId = ProviderInstanceId.make(instanceId);
    const nextMap = {
      ...settings.providerInstances,
      [brandedId]: nextInstance,
    };
    try {
      updateSettings({ providerInstances: nextMap });
      toastManager.add({
        type: "success",
        title: "Provider instance added",
        description: `${driverOption.label} instance '${instanceId}' was added.`,
      });
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not add provider instance",
        description: error instanceof Error ? error.message : "Update failed.",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup>
        <WizardHeader
          title="Add provider instance"
          description={
            <>
              Configure an additional provider instance on {environmentLabel} — for example, a
              second Codex install pointed at a different workspace.
            </>
          }
        >
          <AddProviderInstanceWizardSteps
            currentStep={wizardStep}
            summaries={wizardStepSummaries}
            instanceIdError={instanceIdError}
            onNavigation={applyWizardNavigation}
          />
        </WizardHeader>

        <WizardPanel>
          <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
            <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
              Driver
            </div>
            <RadioGroup
              value={driver}
              onValueChange={handleDriverChange}
              aria-labelledby="add-instance-driver-label"
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              {DRIVER_OPTIONS.map((option) => {
                const IconComponent = option.icon;
                return (
                  <RadioPrimitive.Root
                    key={option.value}
                    value={option.value}
                    className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
                  >
                    <IconComponent className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {option.label}
                    </span>
                    <RadioPrimitive.Indicator
                      className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                      aria-hidden
                    >
                      <CheckIcon className="size-3.5 shrink-0" />
                    </RadioPrimitive.Indicator>
                    {option.badgeLabel ? (
                      <Badge variant="warning" size="sm">
                        {option.badgeLabel}
                      </Badge>
                    ) : null}
                  </RadioPrimitive.Root>
                );
              })}
              {COMING_SOON_DRIVER_OPTIONS.map((option) => {
                const IconComponent = option.icon;
                return (
                  <RadioPrimitive.Root
                    key={option.value}
                    value={option.value}
                    disabled
                    className={cn(
                      "relative flex cursor-not-allowed items-center gap-3 rounded-lg bg-card/60 px-3 py-3 text-left opacity-55 outline-none ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5",
                    )}
                  >
                    <IconComponent className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {option.label}
                    </span>
                    <Badge variant="warning" size="sm">
                      Coming Soon
                    </Badge>
                  </RadioPrimitive.Root>
                );
              })}
            </RadioGroup>
          </div>

          {isAcpRegistry && wizardStep === 1 && !selectedAcp && !manualAcpConfiguration ? (
            <AcpRegistrySearchStep
              environmentId={environmentId}
              providerInstances={settings.providerInstances ?? {}}
              onPrepared={handleAcpPrepared}
              onManualConfiguration={handleManualAcpConfiguration}
            />
          ) : null}

          {isAcpRegistry && wizardStep === 1 && selectedAcp ? (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card px-3 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{selectedAcp.name}</span>
                  <span className="text-[11px] text-muted-foreground">v{selectedAcp.version}</span>
                  <Badge variant="secondary" size="sm">
                    {selectedAcp.distribution}
                  </Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {selectedAcp.description || "ACP-compatible coding agent."}
                </p>
              </div>
              <Button type="button" size="xs" variant="outline" onClick={handleChooseAnotherAcp}>
                Choose another
              </Button>
            </div>
          ) : null}

          {hasAttemptedSubmit && acpSelectionError ? (
            <p className="text-xs text-destructive">{acpSelectionError}</p>
          ) : null}

          <label
            className={cn(
              "grid gap-2",
              (wizardStep !== 1 || (isAcpRegistry && !selectedAcp && !manualAcpConfiguration)) &&
                "hidden",
            )}
          >
            <span className="text-xs font-medium text-foreground">Label</span>
            <Input
              className="bg-background"
              placeholder="e.g. Work"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <span className="text-[11px] text-muted-foreground">
              Shown in the provider list. Optional.
            </span>
          </label>

          <label
            className={cn(
              "grid gap-2",
              (wizardStep !== 1 || (isAcpRegistry && !selectedAcp && !manualAcpConfiguration)) &&
                "hidden",
            )}
          >
            <span className="text-xs font-medium text-foreground">Instance ID</span>
            <Input
              className="bg-background"
              placeholder={`${driver}_work`}
              value={instanceId}
              onChange={(event) => {
                setInstanceIdOverride(event.target.value);
              }}
              aria-invalid={showInstanceIdError}
            />
            {showInstanceIdError ? (
              <span className="text-[11px] text-destructive">{instanceIdError}</span>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                Routing key used by threads and sessions. Letters, digits, '-', or '_'.
              </span>
            )}
          </label>

          <div
            className={cn(
              "grid gap-2",
              (wizardStep !== 1 || (isAcpRegistry && !selectedAcp && !manualAcpConfiguration)) &&
                "hidden",
            )}
          >
            <span className="text-xs font-medium text-foreground">Accent color</span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <input
                type="color"
                value={normalizeProviderAccentColor(accentColor) ?? PROVIDER_ACCENT_SWATCHES[0]}
                onChange={(event) => setAccentColor(event.target.value)}
                aria-label="Provider instance accent color"
                className="h-8 w-10 cursor-pointer rounded-xl border border-input bg-background p-0.5"
              />
              <div className="flex flex-wrap gap-1.5">
                {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
                  const selected = accentColor.toLowerCase() === swatch;
                  return (
                    <button
                      key={swatch}
                      type="button"
                      className={cn(
                        "size-6 cursor-pointer rounded-full border transition",
                        selected
                          ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                          : "border-black/10 hover:scale-105 dark:border-white/20",
                      )}
                      style={{ backgroundColor: swatch }}
                      onClick={() => setAccentColor(swatch)}
                      aria-label={`Use ${swatch} accent`}
                    />
                  );
                })}
              </div>
              {accentColor ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setAccentColor("")}
                >
                  Clear
                </Button>
              ) : null}
            </div>
            <span className="text-[11px] text-muted-foreground">
              Optional marker shown in the picker.
            </span>
          </div>

          {driverSettingsFields.length > 0 ? (
            <div className={cn("grid gap-4", wizardStep !== 2 && "hidden")}>
              {isAcpRegistry ? (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
                  Registry agents are third-party programs with access to this environment. T3 Code
                  verifies published checksums where available, but does not sandbox the agent.
                  {selectedAcp?.id === "amp-acp" ? (
                    <span className="mt-1 block font-medium text-foreground">
                      amp-acp is a community adapter and is not maintained or endorsed by Amp.
                    </span>
                  ) : null}
                </div>
              ) : null}
              <ProviderSettingsForm
                definition={driverOption}
                value={configDraft}
                idPrefix={`add-provider-${driver}`}
                variant="dialog"
                onChange={setConfigDraft}
              />
              {isAcpRegistry ? (
                <div className="grid gap-2 border-t border-border/70 pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-foreground">Environment variables</p>
                      <p className="text-[11px] text-muted-foreground">
                        Mark credentials as secret so values are stored in the server secret store.
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        setEnvironmentVariables((current) => [
                          ...current,
                          makeEnvironmentVariableDraft(),
                        ])
                      }
                    >
                      <PlusIcon className="size-3.5" /> Add
                    </Button>
                  </div>
                  {environmentVariables.map((variable, index) => (
                    <div
                      key={variable.draftId}
                      className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2"
                    >
                      <Input
                        aria-label={`Environment variable ${index + 1} name`}
                        placeholder="VARIABLE_NAME"
                        value={variable.name}
                        onChange={(event) =>
                          setEnvironmentVariables((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index ? { ...entry, name: event.target.value } : entry,
                            ),
                          )
                        }
                      />
                      <Input
                        aria-label={`Environment variable ${index + 1} value`}
                        placeholder={variable.sensitive ? "Secret value" : "Value"}
                        type={variable.sensitive ? "password" : "text"}
                        value={variable.valueRedacted ? "" : variable.value}
                        onChange={(event) =>
                          setEnvironmentVariables((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, value: event.target.value, valueRedacted: false }
                                : entry,
                            ),
                          )
                        }
                      />
                      <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={variable.sensitive}
                          onChange={(event) =>
                            setEnvironmentVariables((current) =>
                              current.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? { ...entry, sensitive: event.target.checked }
                                  : entry,
                              ),
                            )
                          }
                        />
                        Secret
                      </label>
                      <Button
                        aria-label={`Remove environment variable ${index + 1}`}
                        size="icon-xs"
                        variant="ghost"
                        onClick={() =>
                          setEnvironmentVariables((current) =>
                            current.filter((_, entryIndex) => entryIndex !== index),
                          )
                        }
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                  {environmentError ? (
                    <p className="text-[11px] text-destructive">{environmentError}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : wizardStep === 2 ? (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">
                This driver has no required configuration. You can add the instance now.
              </p>
            </div>
          ) : null}
        </WizardPanel>

        <WizardFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (wizardStep === 0) {
                onOpenChange(false);
                return;
              }
              setWizardStep((step) => Math.max(0, step - 1));
            }}
          >
            {wizardStep === 0 ? "Cancel" : "Back"}
          </Button>
          {wizardStep < ADD_PROVIDER_WIZARD_STEPS.length - 1 ? (
            <Button onClick={() => navigateToStep(wizardStep + 1)}>Next</Button>
          ) : (
            <Button onClick={handleSave}>Add instance</Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
