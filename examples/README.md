# rlmx Examples

Two different kinds of thing live here, and they install in different places.

**[`agents/`](agents/) — `agent.yaml` microagent recipes.** Every microagent
this repo ships is in that one tree: `explore`, `explore-r`, `codebase-qa`,
`changelog`, `log-triage`, `hello-world`, `research-agent`, `brain-triage`.
Copy one into a discovery root (`<project>/.rlmx/agents/<name>/` or
`~/.rlmx/agents/<name>/`) and `rlmx mcp` exposes it as an `rlmx_<name>` tool.
Start at [`agents/README.md`](agents/README.md).

**Everything below — `rlmx.yaml` configurations** for different use cases.
These configure a whole `rlmx "query" --context …` run; they are not
microagents and do not belong in a discovery root.

> `codebase-qa` exists in both senses, and they are different artifacts:
> [`codebase-qa/`](codebase-qa/) is the config below,
> [`agents/codebase-qa/`](agents/codebase-qa/) is the microagent.

## Tauri Docs

Research agent for Tauri v2 documentation. Loads `.md` and `.mdx` files, uses `standard` tools with custom API reference search.

```bash
cd my-tauri-project
cp ../examples/tauri-docs/rlmx.yaml .
rlmx "How does IPC work in Tauri v2?" --context ./docs/
```

## Codebase Q&A

Code analysis agent that traces execution flows across a project. Loads `.ts`, `.js`, `.py`, and `.json` files. Uses `full` tools with import tracing and definition search.

```bash
cd my-project
cp ../examples/codebase-qa/rlmx.yaml .
rlmx "How does authentication work?" --context ./src/
```

## Paper Review

Academic peer reviewer that systematically evaluates research papers. Uses `core` tools (paper-faithful) with custom claim extraction and methodology analysis.

```bash
cp examples/paper-review/rlmx.yaml .
rlmx "Review this paper" --context paper.md
```

## Customizing

Copy any example and edit:

- **model** — change provider/model for different LLMs
- **system** — customize the agent's persona and instructions
- **tools** — add Python functions the LLM can call in the REPL
- **criteria** — control the output format
- **context** — set file extensions and exclude patterns
- **budget** — set cost/token/depth limits
- **tools-level** — `core` (6 functions), `standard` (+batteries), `full` (+package detection)
