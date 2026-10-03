/** Flag and option readers over argv, and the one structural check argv gets against a command's spec. */
import { DEFAULT_RUNTIME_DIR } from "../paths.ts";
import type { CommandSpec } from "./commands.ts";
import { usageError } from "./usage-error.ts";

export function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

/**
 * The token after `name`, or undefined when the flag is absent. positionalArgs
 * has already proven that a declared value-bearing flag is followed by a real
 * value, so this can never hand back another flag or an empty string.
 */
export function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

interface NumberOptionSpec {
  min?: number;
  max?: number;
  integer?: boolean;
  /** Used when the flag is absent. */
  fallback: number;
}

/**
 * Reads a numeric option. Anything that is not a number in range is a usage
 * error, so NaN and out-of-range values never reach the runtime.
 */
export function numberOption(args: string[], name: string, spec: NumberOptionSpec): number {
  const raw = option(args, name);
  if (raw === undefined) return spec.fallback;
  const value = Number(raw);
  const noun = spec.integer ? "a whole number" : "a number";
  const range =
    spec.min !== undefined && spec.max !== undefined
      ? `between ${spec.min} and ${spec.max}`
      : spec.min !== undefined
        ? `of at least ${spec.min}`
        : "";
  const expected = range ? `${noun} ${range}` : noun;
  if (!Number.isFinite(value)) usageError(`${name} expects ${expected}, got "${raw}"`);
  if (spec.integer && !Number.isInteger(value)) usageError(`${name} expects ${expected}, got "${raw}"`);
  if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
    usageError(`${name} must be ${range}, got ${value}`);
  }
  return value;
}

/** Reads an option that must be one of `allowed`, keeping the literal type of the default. */
export function enumOption<T extends number>(args: string[], name: string, allowed: readonly T[], fallback: T): T {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!allowed.includes(value as T)) usageError(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  return value as T;
}

/** A named choice, rejected up front instead of failing later inside the pipeline. */
export function choiceOption<T extends string>(args: string[], name: string, allowed: readonly T[], fallback?: T): T | undefined {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) usageError(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  return raw as T;
}

/** `--adapter` as a non-negative index, or undefined when absent. */
export function adapterOption(args: string[]): number | undefined {
  const raw = option(args, "--adapter");
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) usageError(`--adapter expects a non-negative index from \`probe\`, got "${raw}"`);
  return Number(raw);
}

/** `--runtime`, else the repo's runtime folder: the one place the CLI decides where the DLSS DLLs live. */
export function runtimeDirOption(args: string[]): string {
  return option(args, "--runtime") ?? DEFAULT_RUNTIME_DIR;
}

/** Flag names that consume a following value token, derived from a command spec ("--factor N" does, "--json" does not). */
function valueFlagNames(spec: CommandSpec): Set<string> {
  const s = new Set<string>();
  for (const o of spec.options) {
    const [name, ...rest] = o.flag.split(/\s+/);
    if (rest.length && name) s.add(name);
  }
  return s;
}

/** Every flag this command declares, value-bearing or not. */
function flagNames(spec: CommandSpec): Set<string> {
  return new Set(spec.options.map((o) => o.flag.split(/\s+/)[0]!));
}

/**
 * A token is a flag when it starts with "-" and is not a number. A leading minus
 * alone cannot mean "flag": `nr --skin-structure -1` is documented as
 * "-1 = runtime default" and SETTING_RANGES.skinStructure allows it.
 */
function isFlagToken(token: string): boolean {
  return token.startsWith("-") && Number.isNaN(Number(token));
}

/**
 * The one structural check argv gets: it validates the flags against the
 * command's spec and returns the positionals. Every reader below — option,
 * numberOption, enumOption, choiceOption, adapterOption — may therefore assume a
 * flag that is present is followed by a real value.
 *
 * A value-bearing flag's value token is skipped: without that, the `3` in
 * `sr in.png --factor 3` would be read as the output path.
 *
 * An undeclared flag is rejected rather than ignored, single dash included:
 * skipping it would leave its value token to be read as the output path
 * (`fg movie.mp4 --adapter 0` would write a file named `0`).
 *
 * A flag whose value is missing, blank or another flag is a usage error, never
 * a default: `fg in.mp4 --fps`, or `--fps "$Unset"` where the shell drops the
 * argument or passes it empty, must not run the job at the default rate.
 */
export function positionalArgs(args: string[], spec: CommandSpec): string[] {
  const valued = valueFlagNames(spec);
  const known = flagNames(spec);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!isFlagToken(a)) {
      out.push(a);
      continue;
    }
    if (!known.has(a)) usageError(`unknown option '${a}' for ${spec.name}`, spec.name);
    if (valued.has(a)) {
      const value = args[i + 1];
      if (value === undefined || isFlagToken(value) || value.trim() === "") throwMissingValue(spec, a, value);
      i++; // skip this flag's value token
    }
  }
  return out;
}

/** Usage error for a value-bearing flag whose value is missing, blank or another flag. */
function throwMissingValue(spec: CommandSpec, name: string, value: string | undefined): never {
  // The caller checked the flag against flagNames(spec), so the spec carries it.
  const declared = spec.options.find((o) => o.flag.split(/\s+/)[0] === name)!;
  const cause =
    value === undefined ? "nothing followed it" : value.trim() === "" ? "the value was empty" : `'${value}' is another option`;
  const shown = declared.def === undefined ? "" : ` (default ${declared.def})`;
  usageError(`${name} expects a value -- ${cause}. ${declared.flag}: ${declared.desc}${shown}`);
}
