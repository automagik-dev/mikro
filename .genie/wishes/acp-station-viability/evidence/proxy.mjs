// Logging reverse proxy: rlmx -> :13399 -> Lemonade :13305
// Captures the EXACT wire traffic at the station-provider seam.
// Touches no tracked source; rlmx reaches it via STATION_BASE_URL.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const UP = "http://localhost:13305";
const PORT = Number(process.env.PROXY_PORT || 13399);
const OUT = process.env.PROXY_LOG || "./evidence/proxy.jsonl";
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const log = (o) => fs.appendFileSync(OUT, JSON.stringify(o) + "\n");

let seq = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const id = ++seq;
    const reqBody = Buffer.concat(chunks).toString("utf8");
    const t0 = Date.now();
    let parsed = null;
    try { parsed = JSON.parse(reqBody); } catch {}

    // Per-message accounting of exactly what rlmx sends.
    const msgs = parsed?.messages ?? [];
    const rec = {
      id,
      ts: new Date().toISOString(),
      phase: "request",
      method: req.method,
      url: req.url,
      bytes: reqBody.length,
      model: parsed?.model,
      stream: parsed?.stream,
      max_tokens: parsed?.max_tokens,
      temperature: parsed?.temperature,
      msgCount: msgs.length,
      totalChars: msgs.reduce((a, m) => a + String(m?.content ?? "").length, 0),
      messages: msgs.map((m) => ({
        role: m?.role,
        chars: String(m?.content ?? "").length,
        head: String(m?.content ?? "").slice(0, 400),
        tail: String(m?.content ?? "").slice(-400),
      })),
    };
    log(rec);
    // Full first request body verbatim, for the exact-scaffold replay.
    if (parsed?.messages) {
      fs.writeFileSync(`${OUT}.req${id}.json`, reqBody);
    }

    const upstream = await fetch(UP + req.url, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : reqBody,
    }).catch((e) => ({ __err: String(e) }));

    if (upstream.__err) {
      log({ id, ts: new Date().toISOString(), phase: "upstream_error", ms: Date.now() - t0, error: upstream.__err });
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: upstream.__err }));
      return;
    }

    const body = await upstream.text();
    const ms = Date.now() - t0;
    let rj = null;
    try { rj = JSON.parse(body); } catch {}
    log({
      id,
      ts: new Date().toISOString(),
      phase: "response",
      ms,
      status: upstream.status,
      bytes: body.length,
      // Only summarize completions; /models is huge and uninteresting.
      content: rj?.choices?.[0]?.message?.content ?? null,
      contentChars: (rj?.choices?.[0]?.message?.content ?? "").length,
      reasoning: (rj?.choices?.[0]?.message?.reasoning_content ?? "").slice(0, 600) || null,
      reasoningChars: (rj?.choices?.[0]?.message?.reasoning_content ?? "").length,
      finish_reason: rj?.choices?.[0]?.finish_reason ?? null,
      usage: rj?.usage ?? null,
      errorBody: upstream.status >= 400 ? body.slice(0, 800) : null,
      // Non-JSON (e.g. SSE stream) — keep raw head/tail so nothing is lost.
      rawHead: rj ? null : body.slice(0, 1500),
      rawTail: rj ? null : body.slice(-1500),
    });
    if (!rj && req.url.includes("chat/completions")) {
      fs.writeFileSync(`${OUT}.resp${id}.raw`, body);
    }

    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
    res.end(body);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log({ ts: new Date().toISOString(), phase: "proxy_up", port: PORT, upstream: UP });
  console.log(`proxy up on ${PORT} -> ${UP}, log=${OUT}`);
});
