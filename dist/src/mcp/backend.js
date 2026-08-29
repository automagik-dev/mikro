/**
 * Runtime backend seam — Wish rlmx-v2-prime-backend Group 1.
 *
 * The MCP server used to call `rlmLoop` directly; it now calls a backend.
 * That inversion is the whole point of this module: the server owns the
 * MCP contract (tools, sessions, result shape, progress presentation) and a
 * backend owns "what actually executes the turn", so a second engine can
 * slot in behind the same host-visible surface.
 *
 * The request carries the MCP request's AbortSignal. Backends that own a
 * killable execution boundary (Prime's subprocess) must honor it; legacy's
 * in-process rlmLoop cannot yet consume it and remains deadline-bounded.
 */
export {};
//# sourceMappingURL=backend.js.map