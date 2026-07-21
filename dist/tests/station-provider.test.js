import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { STATION_BASELINE_MODELS, STATION_BASE_URL, STATION_PROVIDER_ID, registerStationProvider, stationProvider, } from "../src/station-provider.js";
// These are offline structural checks — no live gateway required. The live
// three-model completions (incl. the NPU gate) are validated by the wish's
// smoke run, not the unit suite.
describe("station provider", () => {
    it("registers a first-class `station` provider on a Models runtime", () => {
        const models = builtinModels();
        registerStationProvider(models);
        assert.ok(models.getProvider(STATION_PROVIDER_ID), "station provider should be registered");
    });
    it("resolves all three baseline models via getModel(provider, id)", () => {
        const models = builtinModels();
        registerStationProvider(models);
        for (const id of [
            "qwen3.5-2b-FLM",
            "Qwen3.6-35B-A3B-MTP-GGUF",
            "Qwen3.5-4B-MTP-GGUF",
        ]) {
            const m = models.getModel(STATION_PROVIDER_ID, id);
            assert.ok(m, `station/${id} should resolve`);
            assert.equal(m?.provider, STATION_PROVIDER_ID);
            assert.equal(m?.baseUrl, STATION_BASE_URL);
            assert.deepEqual(m?.input, ["text"]);
            assert.equal(m?.cost.input, 0);
            assert.equal(m?.cost.output, 0);
            assert.equal(m?.maxTokens, 8192);
        }
    });
    it("base URL targets the gateway's /api/v1 (not /v1)", () => {
        assert.match(STATION_BASE_URL, /\/api\/v1$/);
    });
    it("applies qwen-chat-template thinking format to the GGUF Qwen MTP models", () => {
        const gguf = STATION_BASELINE_MODELS.filter((m) => m.id.endsWith("-GGUF"));
        assert.equal(gguf.length, 2, "expected two GGUF baseline models");
        for (const m of gguf) {
            assert.equal(m.reasoning, true, `${m.id} needs reasoning:true for the thinking branch`);
            assert.equal(m.compat?.thinkingFormat, "qwen-chat-template", `${m.id} must send chat_template_kwargs so streaming yields content`);
            assert.equal(m.compat?.supportsDeveloperRole, false);
            assert.equal(m.compat?.supportsReasoningEffort, false);
        }
    });
    it("keeps the NPU FastFlowLM model minimal (no thinking format)", () => {
        const flm = STATION_BASELINE_MODELS.find((m) => m.id === "qwen3.5-2b-FLM");
        assert.ok(flm);
        assert.equal(flm?.reasoning, false);
        assert.equal(flm?.compat?.thinkingFormat, undefined);
        assert.equal(flm?.compat?.supportsDeveloperRole, false);
        assert.equal(flm?.compat?.supportsReasoningEffort, false);
    });
    it("keyless auth resolves as configured (local server)", async () => {
        const provider = stationProvider();
        const resolved = await provider.auth.apiKey?.resolve({
            // The resolver ignores ctx/credential — it always reports configured.
            ctx: {},
            credential: undefined,
        });
        assert.ok(resolved, "keyless auth must report configured");
        assert.ok(resolved?.auth.apiKey, "keyless auth must supply a placeholder key");
    });
});
//# sourceMappingURL=station-provider.test.js.map