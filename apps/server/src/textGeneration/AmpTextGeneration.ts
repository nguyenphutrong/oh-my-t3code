import {
  createPermission,
  execute as executeAmp,
  type AmpOptions,
  type StreamMessage,
} from "@ampcode/sdk";
import { type AmpSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { startAmpExecution, type AmpSdkExecute } from "../provider/Layers/AmpSdkRuntime.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const AMP_TEXT_GENERATION_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const VALID_MODES = new Set(["low", "medium", "high", "ultra"]);
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const isTextGenerationError = Schema.is(TextGenerationError);

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

function compactEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
}

function ampOptions(input: {
  readonly settings: AmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
}): AmpOptions {
  const mode = VALID_MODES.has(input.modelSelection.model) ? input.modelSelection.model : "low";
  const effort = getProviderOptionStringSelectionValue(
    input.modelSelection.options,
    "reasoningEffort",
  );
  return {
    cwd: input.cwd,
    mode,
    ...(effort && VALID_EFFORTS.has(effort) ? { effort: effort as AmpOptions["effort"] } : {}),
    ...(input.settings.settingsFile ? { settingsFile: input.settings.settingsFile } : {}),
    env: compactEnvironment(input.environment),
    visibility: "private",
    noArchiveAfterExecute: true,
    permissions: [createPermission("*", "reject")],
  };
}

export const makeAmpTextGeneration = Effect.fn("makeAmpTextGeneration")(function* (
  settings: AmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  execute: AmpSdkExecute = executeAmp,
) {
  const runAmpJson = <S extends Schema.Top>(input: {
    readonly operation: Operation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> => {
    const abortController = new AbortController();
    return Effect.tryPromise({
      try: async () => {
        const started = await startAmpExecution({
          execute,
          binaryPath: settings.binaryPath,
          options: {
            prompt: input.prompt,
            options: ampOptions({
              settings,
              environment,
              cwd: input.cwd,
              modelSelection: input.modelSelection,
            }),
            signal: abortController.signal,
          },
        });
        let current = started.first;
        let assistantText = "";
        let result: Extract<StreamMessage, { type: "result" }> | undefined;
        while (!current.done) {
          const message = current.value;
          if (message.type === "assistant")
            for (const content of message.message.content)
              if (content.type === "text") {
                assistantText += content.text;
                if (assistantText.length > MAX_OUTPUT_CHARS)
                  throw new Error("Amp text generation output exceeded 1 MiB.");
              }
          if (message.type === "result") result = message;
          current = await started.iterator.next();
        }
        if (!result) throw new Error("Amp exited before returning a result.");
        if (result.is_error) throw new Error(result.error);
        const output = (result.result || assistantText).trim();
        if (!output) throw new Error("Amp returned empty output.");
        if (output.length > MAX_OUTPUT_CHARS)
          throw new Error("Amp text generation output exceeded 1 MiB.");
        return output;
      },
      catch: (cause) =>
        new TextGenerationError({
          operation: input.operation,
          detail: "Amp SDK text generation failed.",
          cause,
        }),
    }).pipe(
      Effect.timeoutOption(AMP_TEXT_GENERATION_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Amp SDK text generation timed out.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.onInterrupt(() => Effect.sync(() => abortController.abort())),
      Effect.flatMap((output) =>
        Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
          extractJsonObject(output),
        ).pipe(
          Effect.catchTags({
            SchemaError: (cause) =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Amp returned invalid structured output.",
                  cause,
                }),
              ),
          }),
        ),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Amp text generation failed.",
              cause,
            }),
      ),
    );
  };

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AmpTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runAmpJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("AmpTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runAmpJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("AmpTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runAmpJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("AmpTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });
      const generated = yield* runAmpJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
