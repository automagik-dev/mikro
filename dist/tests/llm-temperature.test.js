import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPiOptions } from "../src/llm.js";
/**
 * The last leg of the temperature knob: `MikroConfig.temperature` →
 * `llmComplete({ temperature })` → the `temperature` key on the pi-ai options
 * object handed to `models.completeSimple`.
 *
 * `buildPiOptions` is the assertable seam — the exact object pi-ai receives,
 * minus the payload hooks, without a network call. Two properties matter and
 * neither is visible from a response body:
 *
 *  1. A pinned `0` arrives as `0`. Every guard between here and the yaml is
 *     written `!= null` precisely so greedy decoding survives; a truthiness
 *     check anywhere on the path degrades silently to "provider default".
 *  2. An unset temperature leaves **no key at all**. Not `undefined`, not
 *     `null` — absent. Some providers serialize a present-but-undefined key,
 *     and `null` goes on the wire as a value, so "absent knob ⇒ byte-for-byte
 *     the options object we sent before this feature existed" only holds if the
 *     assignment is conditional.
 */
describe("buildPiOptions — temperature", () => {
    it("forwards an exact zero as 0", () => {
        const opts = buildPiOptions({ temperature: 0 });
        assert.equal(opts.temperature, 0);
        assert.ok(Object.hasOwn(opts, "temperature"), "a pinned 0 must reach pi-ai as a present key");
    });
    it("forwards ordinary and boundary values unchanged", () => {
        assert.equal(buildPiOptions({ temperature: 0.7 }).temperature, 0.7);
        assert.equal(buildPiOptions({ temperature: 1 }).temperature, 1);
        assert.equal(buildPiOptions({ temperature: 2 }).temperature, 2);
    });
    it("omits the key entirely when temperature is undefined", () => {
        const opts = buildPiOptions({ maxTokens: 4096 });
        assert.equal(Object.hasOwn(opts, "temperature"), false, "an unset temperature must not appear on the options object");
    });
    it("omits the key entirely when temperature is null", () => {
        // `MikroConfig.temperature` is nullable and is passed through verbatim, so
        // null is the shape the root loop actually hands over for an unset knob.
        const opts = buildPiOptions({ temperature: null });
        assert.equal(Object.hasOwn(opts, "temperature"), false);
    });
    it("omits the key when no options are passed at all", () => {
        assert.equal(Object.hasOwn(buildPiOptions(), "temperature"), false);
        assert.equal(Object.hasOwn(buildPiOptions(undefined), "temperature"), false);
    });
    /**
     * Regression pin for the acceptance criterion "absent knob ⇒ byte-for-byte
     * today's options object". Enumerating the keys is the assertion: adding a
     * sampling knob must not have added anything to an un-pinned call.
     */
    it("leaves an un-pinned call's option keys exactly as they were", () => {
        assert.deepEqual(Object.keys(buildPiOptions()).sort(), ["maxTokens", "signal"]);
        assert.deepEqual(Object.keys(buildPiOptions({ thinkingLevel: "low" })).sort(), ["maxTokens", "reasoning", "signal"]);
    });
    it("carries temperature alongside the other options rather than replacing them", () => {
        const signal = new AbortController().signal;
        const opts = buildPiOptions({
            temperature: 0,
            thinkingLevel: "high",
            maxTokens: 2048,
            signal,
            cacheConfig: { enabled: true, retention: "long", sessionId: "s1" },
        });
        assert.equal(opts.temperature, 0);
        assert.equal(opts.reasoning, "high");
        assert.equal(opts.maxTokens, 2048);
        assert.equal(opts.signal, signal);
        assert.equal(opts.cacheRetention, "long");
        assert.equal(opts.sessionId, "s1");
    });
});
/**
 * `thinkingLevel` keeps its own truthiness guard on purpose — its levels are
 * strings and it has no falsy-but-meaningful value — so these pin that the
 * temperature work did not disturb it.
 */
describe("buildPiOptions — unchanged behaviour", () => {
    it("defaults maxTokens to 16384", () => {
        assert.equal(buildPiOptions().maxTokens, 16384);
    });
    it("omits cache options when the cache is disabled", () => {
        const opts = buildPiOptions({
            cacheConfig: { enabled: false, retention: "long", sessionId: "s1" },
        });
        assert.equal(Object.hasOwn(opts, "cacheRetention"), false);
        assert.equal(Object.hasOwn(opts, "sessionId"), false);
    });
    it("omits reasoning when no thinking level is given", () => {
        assert.equal(Object.hasOwn(buildPiOptions({ thinkingLevel: null }), "reasoning"), false);
    });
});
//# sourceMappingURL=llm-temperature.test.js.map