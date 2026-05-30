import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RLMX_CLI_SCHEMA } from "../src/schema.js";

describe("RLMX_CLI_SCHEMA", () => {
  it("describes at least ten CLI flags including v0.4 flags", () => {
    assert.ok(Array.isArray(RLMX_CLI_SCHEMA.flags));
    assert.ok(RLMX_CLI_SCHEMA.flags.length >= 10);

    const flags = new Map(RLMX_CLI_SCHEMA.flags.map((flag) => [flag.name, flag]));
    for (const name of ["--thinking", "--cache", "--batch-api", "--tools"]) {
      assert.ok(flags.has(name), `${name} missing from schema flags`);
      assert.equal(typeof flags.get(name)?.description, "string");
    }
  });

  it("describes the JSON output object as JSON Schema", () => {
    assert.equal(RLMX_CLI_SCHEMA.output.type, "object");
    assert.ok(RLMX_CLI_SCHEMA.output.properties.answer);
    assert.ok(RLMX_CLI_SCHEMA.output.properties.references);
    assert.ok(RLMX_CLI_SCHEMA.output.properties.usage);
    assert.ok(RLMX_CLI_SCHEMA.output.required?.includes("answer"));
  });

  it("lists documented exit codes and meanings", () => {
    const exitCodes = new Map(RLMX_CLI_SCHEMA.exitCodes.map((entry) => [entry.code, entry.meaning]));
    assert.equal(exitCodes.get(0), "success");
    assert.ok(exitCodes.get(1)?.includes("error"));
    assert.ok(exitCodes.get(2)?.includes("rtk"));
    assert.ok(exitCodes.get(130)?.includes("SIGINT"));
    assert.ok(exitCodes.get(143)?.includes("SIGTERM"));
  });
});
