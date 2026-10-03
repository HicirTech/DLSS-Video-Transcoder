/**
 * How the CLI reads argv: a flag or value it cannot accept is a UsageError, which the entry point ends
 * with exit status 2, never a silent default. No GPU.
 */
import { describe, expect, test } from "bun:test";
import { adapterOption, choiceOption, enumOption, numberOption, positionalArgs } from "../src/cli/args.ts";
import { commandSpec } from "../src/cli/commands.ts";
import { UsageError } from "../src/cli/usage-error.ts";

/** The UsageError `run` raises; any other outcome fails the test. */
function usageErrorOf(run: () => unknown): UsageError {
  try {
    run();
  } catch (error) {
    if (error instanceof UsageError) return error;
    throw error;
  }
  throw new Error("expected a UsageError, but nothing was raised");
}

describe("numberOption", () => {
  const spec = { min: 0.1, max: 8, fallback: 2 };

  test("an absent flag gives the fallback and a value in range is read as typed", () => {
    expect(numberOption([], "--factor", spec)).toBe(2);
    expect(numberOption(["--factor", "1.5"], "--factor", spec)).toBe(1.5);
  });

  test("a value outside the range is a usage error that names the range and the value", () => {
    expect(usageErrorOf(() => numberOption(["--factor", "9"], "--factor", spec)).message).toBe("--factor must be between 0.1 and 8, got 9");
  });

  test("text that is not a number, and a fraction where a whole number is required, are usage errors", () => {
    expect(usageErrorOf(() => numberOption(["--factor", "abc"], "--factor", spec)).message).toBe('--factor expects a number between 0.1 and 8, got "abc"');
    const whole = { min: 1, max: 16, integer: true, fallback: 2 };
    expect(usageErrorOf(() => numberOption(["--multiplier", "2.5"], "--multiplier", whole)).message).toBe('--multiplier expects a whole number between 1 and 16, got "2.5"');
  });
});

describe("enumOption, choiceOption and adapterOption", () => {
  test("a value outside the allowed set is a usage error that lists the set", () => {
    expect(enumOption(["--style", "2"], "--style", [0, 1, 2], 0)).toBe(2);
    expect(usageErrorOf(() => enumOption(["--style", "3"], "--style", [0, 1, 2], 0)).message).toBe('--style must be one of 0, 1, 2, got "3"');
    expect(choiceOption(["--engine", "native"], "--engine", ["auto", "native", "cascade"])).toBe("native");
    expect(usageErrorOf(() => choiceOption(["--engine", "warp"], "--engine", ["auto", "native", "cascade"])).message).toBe('--engine must be one of auto, native, cascade, got "warp"');
  });

  test("--adapter is a non-negative index or absent", () => {
    expect(adapterOption([])).toBeUndefined();
    expect(adapterOption(["--adapter", "1"])).toBe(1);
    expect(usageErrorOf(() => adapterOption(["--adapter", "-1"])).message).toContain('got "-1"');
    expect(usageErrorOf(() => adapterOption(["--adapter", "x"])).message).toContain('got "x"');
  });
});

describe("positionalArgs", () => {
  const sr = commandSpec("sr");

  test("returns the positionals and skips the value of a value-bearing flag", () => {
    expect(positionalArgs(["in.png", "--factor", "3", "out.png"], sr)).toEqual(["in.png", "out.png"]);
    // A negative number is a value, not a flag: --skin-structure takes -1.
    expect(positionalArgs(["in.png", "--skin-structure", "-1"], commandSpec("nr"))).toEqual(["in.png"]);
  });

  test("an undeclared flag is a usage error that carries the command whose help page it asks for", () => {
    const error = usageErrorOf(() => positionalArgs(["in.png", "--bogus"], sr));
    expect(error.message).toBe("unknown option '--bogus' for sr");
    expect(error.command).toBe("sr");
    // Single dash included: its value token must not become the output path.
    expect(usageErrorOf(() => positionalArgs(["in.png", "-factor", "3"], sr)).command).toBe("sr");
  });

  test("a flag whose value is missing, blank or another flag is a usage error, never a default", () => {
    expect(usageErrorOf(() => positionalArgs(["in.png", "--factor"], sr)).message).toContain("nothing followed it");
    expect(usageErrorOf(() => positionalArgs(["in.png", "--factor", ""], sr)).message).toContain("the value was empty");
    expect(usageErrorOf(() => positionalArgs(["in.png", "--factor", "--preset", "L"], sr)).message).toContain("'--preset' is another option");
  });
});
