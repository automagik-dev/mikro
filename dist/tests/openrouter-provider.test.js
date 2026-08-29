import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { resolveOpenRouterModel, synthesizeOpenRouterModel, } from "../src/openrouter-provider.js";
describe("forward-compatible OpenRouter model resolution", () => {
    it("synthesizes every requested cheap model missing from pi-ai's snapshot", () => {
        const models = builtinModels();
        for (const id of [
            "~deepseek/deepseek-v4-flash-latest",
            "qwen/qwen3.7-flash",
            "z-ai/glm-5.3-flash",
            "xiaomi/mimo-v2.5",
        ]) {
            const model = resolveOpenRouterModel(models, id);
            assert.equal(model.provider, "openrouter");
            assert.equal(model.id, id);
            assert.equal(model.api, "openai-completions");
            assert.equal(model.baseUrl, "https://openrouter.ai/api/v1");
            assert.ok(model.contextWindow >= 1_000_000);
            assert.ok(model.cost.input > 0);
            assert.ok(model.cost.output > 0);
        }
    });
    it("keeps unknown future ids flippable with conservative metadata", () => {
        const model = synthesizeOpenRouterModel("vendor/not-in-this-build-yet");
        assert.equal(model.id, "vendor/not-in-this-build-yet");
        assert.deepEqual(model.input, ["text"]);
        assert.equal(model.contextWindow, 128_000);
        assert.equal(model.cost.input, 0);
    });
    it("prefers pi-ai's richer descriptor when the catalog knows the id", () => {
        const models = builtinModels();
        const existing = models.getModel("openrouter", "anthropic/claude-opus-4.8");
        assert.ok(existing);
        assert.equal(resolveOpenRouterModel(models, "anthropic/claude-opus-4.8"), existing);
    });
});
//# sourceMappingURL=openrouter-provider.test.js.map