import type { ExecuteOptions, StreamMessage } from "@ampcode/sdk";

export type AmpSdkExecute = (options: ExecuteOptions) => AsyncIterable<StreamMessage>;

export interface StartedAmpExecution {
  readonly first: IteratorResult<StreamMessage>;
  readonly iterator: AsyncIterator<StreamMessage>;
}

let launchTail: Promise<void> = Promise.resolve();

async function withLaunchLock<A>(run: () => Promise<A>): Promise<A> {
  const previous = launchTail;
  let release!: () => void;
  launchTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

function usesDefaultAmpBinary(binaryPath: string): boolean {
  return binaryPath.trim() === "" || binaryPath.trim() === "amp";
}

/**
 * The SDK discovers custom Amp binaries through process.env.AMP_CLI_PATH.
 * Keep that process-global mutation only until the child has started, and
 * serialize that short launch window so concurrent provider instances cannot
 * inherit one another's configured binary.
 */
export function startAmpExecution(input: {
  readonly execute: AmpSdkExecute;
  readonly options: ExecuteOptions;
  readonly binaryPath: string;
}): Promise<StartedAmpExecution> {
  return withLaunchLock(async () => {
    const previous = process.env.AMP_CLI_PATH;
    if (!usesDefaultAmpBinary(input.binaryPath)) {
      process.env.AMP_CLI_PATH = input.binaryPath;
    }
    try {
      const iterator = input.execute(input.options)[Symbol.asyncIterator]();
      const first = await iterator.next();
      return { first, iterator };
    } finally {
      if (previous === undefined) delete process.env.AMP_CLI_PATH;
      else process.env.AMP_CLI_PATH = previous;
    }
  });
}
