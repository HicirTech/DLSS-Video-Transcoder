/**
 * The DLSS Frame Generation parameter names. A misspelt name is not an error at the NGX
 * boundary: the runtime just never sees the value, so the tables are checked here.
 */
import { describe, expect, test } from "bun:test";
import { DlssgCapabilityParam, DlssgCreateParam, DlssgEvaluateParam } from "../src/ngx/dlssg-params.ts";
import { NgxParam } from "../src/ngx/params.ts";

const tables = { DlssgCapabilityParam, DlssgCreateParam, DlssgEvaluateParam };

describe("DLSS-G parameter names", () => {
  // Every name in nvsdk_ngx_defs_dlssg.h that we use is "DLSSG." plus its key, so a key
  // pointing at a sibling's string (MultiFrameIndex -> "DLSSG.MultiFrameCount") shows here.
  test("each name is DLSSG. followed by its own key", () => {
    for (const table of Object.values(tables)) {
      for (const [key, name] of Object.entries<string>(table)) expect(name).toBe(`DLSSG.${key}`);
    }
  });

  test("no name is declared twice across the tables", () => {
    const names = Object.values(tables).flatMap((table) => Object.values(table));
    expect(new Set(names).size).toBe(names.length);
  });

  // The generic names (Width, Height, node masks, FrameGeneration.*) have one owner, NgxParam.
  test("no DLSS-G table re-declares a name NgxParam owns", () => {
    const generic = new Set<string>(Object.values(NgxParam));
    for (const table of Object.values(tables)) {
      for (const name of Object.values(table)) expect(generic.has(name)).toBe(false);
    }
  });
});
