/**
 * ACP direct mode, per-mode failure surfaces, and the turn knobs — wish
 * acp-station-viability, Group 2.
 *
 * Hermetic: every prompt turn below runs the REAL `RlmxAcpAgent.prompt` against
 * injected collaborators (`AgentDeps`) — a fake provider, a fake loop, a fake
 * config loader, a captured env and a recording session-update sink. Nothing
 * here touches a network, a REPL, a real `process.env` knob, or the user's home
 * (`RLMX_ACP_SESSIONS_DIR` points at a temp dir for the whole file).
 *
 * Proves the wish's hermetic criteria:
 *   C3  the `loop:` key absent → the rlmLoop path, with the loop's OWN defaults.
 *   C4  all four traced failure surfaces → structured ACP errors; none resolves
 *       `end_turn`; none appends a turn to the durable store.
 *   C5  RLMX_ACP_MAX_ITERATIONS honored, including the guard's negatives.
 *   +   the direct happy path: one completion, whole answer, preamble carried,
 *       turn appended; and the one-time missing-FINAL-protocol diagnostic.
 *
 * A structured error does NOT recover a discarded answer — see the trace
 * report's clarifying note. These tests assert honest reporting, nothing more.
 */
export {};
//# sourceMappingURL=acp-direct-mode.test.d.ts.map