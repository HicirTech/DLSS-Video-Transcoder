/** The CLI's usage error, and the exit status it and a failed run get: the one rule for how a command ends. */

/** Exit status of a run that failed; `probe` also ends with it when neural rendering is not ready. */
export const EXIT_FAILED = 1;
/** Exit status of a command line that is wrong: an unknown command or option, a value an option does not accept, a missing argument. */
export const EXIT_USAGE = 2;

/** A wrong command line. The entry point prints it, followed by `command`'s help page when that is set, and exits with EXIT_USAGE. */
export class UsageError extends Error {
  constructor(message: string, readonly command?: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Raises a UsageError; every bad-argument path goes through here so the wording and the exit status stay consistent. */
export function usageError(message: string, command?: string): never {
  throw new UsageError(message, command);
}
