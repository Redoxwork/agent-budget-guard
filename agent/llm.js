// Minimal LLM client. Works with any OpenAI-compatible API (OpenAI, Groq, OpenRouter…)
// or Anthropic. Configure in .env:
//   LLM_PROVIDER=openai | anthropic
//   LLM_API_KEY=...
//   LLM_BASE_URL=https://api.groq.com/openai/v1   (OpenAI-compatible only; default api.openai.com)
//   LLM_MODEL=llama-3.3-70b-versatile | gpt-4o-mini | claude-sonnet-...
require("dotenv").config({ path: __dirname + "/../.env", quiet: true });

const PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const KEY = process.env.LLM_API_KEY;
const BASE = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || (PROVIDER === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o-mini");

const hasLLM = () => Boolean(KEY);

/**
 * chat({ system, messages, tools }) -> { text, toolCalls: [{id, name, args}] , raw }
 * messages use a neutral format:
 *   {role:"user", content} | {role:"assistant", content, toolCalls} | {role:"tool", id, name, content}
 * tools: [{name, description, parameters(JSON schema)}]
 */
async function chat({ system, messages, tools = [], json = false }) {
  if (!KEY) throw new Error("No LLM_API_KEY set");
  return PROVIDER === "anthropic" ? anthropic({ system, messages, tools }) : openai({ system, messages, tools, json });
}

async function openai({ system, messages, tools, json }) {
  const msgs = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") msgs.push({ role: "tool", tool_call_id: m.id, content: m.content });
    else if (m.role === "assistant")
      msgs.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length && {
          tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })),
        }),
      });
    else msgs.push({ role: "user", content: m.content });
  }
  const body = {
    model: MODEL,
    messages: msgs,
    temperature: 0.2,
    ...(tools.length && { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }),
    ...(json && { response_format: { type: "json_object" } }),
  };
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const m = j.choices[0].message;
  return {
    text: m.content || "",
    toolCalls: (m.tool_calls || []).map((t) => ({ id: t.id, name: t.function.name, args: safeJson(t.function.arguments) })),
  };
}

async function anthropic({ system, messages, tools }) {
  const msgs = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.id, content: m.content };
      const last = msgs[msgs.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") last.content.push(block);
      else msgs.push({ role: "user", content: [block] });
    } else if (m.role === "assistant") {
      const content = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const t of m.toolCalls || []) content.push({ type: "tool_use", id: t.id, name: t.name, input: t.args });
      msgs.push({ role: "assistant", content });
    } else msgs.push({ role: "user", content: m.content });
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: msgs,
      ...(tools.length && { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }),
    }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return {
    text: j.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
    toolCalls: j.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input })),
  };
}

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

module.exports = { chat, hasLLM, PROVIDER, MODEL };
