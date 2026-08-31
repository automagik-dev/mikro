/**
 * VALIDATE.md enforcement on the FINAL channel (`rlmLoop`).
 *
 * The defect these tests pin: `src/sdk/validate.ts` shipped the schema check,
 * the retry policy and the hint text, and `runAgent()` wired them for the SDK
 * surface — but the core loop, which serves the CLI *and* the default MCP
 * backend, never validated anything. A pack's `VALIDATE.md` was inert there
 * and the first FINAL won, conforming or not.
 *
 * `rlmLoop` itself has no injection seam for the LLM or the Python REPL, so
 * the loop is not driven end to end here. What is tested instead is every
 * decision the loop delegates — the disclosure section both prompt builders
 * append, the normalization FINAL needs before `JSON.parse`, the
 * validate/retry/flag policy, and the history mutation a granted retry makes.
 * Site adoption (which `finalize()` calls route through the wrapper) is
 * verified by inspection in review, as the wish allows; the end-to-end
 * propagation of the resulting flag is covered in
 * `tests/backend-contract.test.ts`.
 */
export {};
//# sourceMappingURL=validate-loop.test.d.ts.map