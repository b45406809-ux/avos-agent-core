var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// api/dispatch.js
async function onRequestPost(context) {
  const { request, env } = context;
  const jsonHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return new Response(JSON.stringify({ error: "Invalid JSON request body" }), { status: 400, headers: jsonHeaders });
    }
    const {
      session_id,
      target_repo,
      target_branch = "main",
      user_prompt,
      execution_mode = "single",
      max_workers = "4",
      max_budget_tokens = "8000000",
      create_pr = false,
      custom_env_json = "{}",
      ui_secret
    } = body;
    if (ui_secret !== env.AGENT_UI_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized: Invalid UI secret passphrase." }), { status: 401, headers: jsonHeaders });
    }
    if (!target_repo || !user_prompt) {
      return new Response(JSON.stringify({ error: "Missing target_repo or user_prompt." }), { status: 400, headers: jsonHeaders });
    }
    const now = Date.now();
    let sessId = session_id;
    let existingSession = null;
    if (sessId) {
      existingSession = await env.DB.prepare(`SELECT id FROM sessions WHERE id = ?`).bind(sessId).first();
    }
    if (!existingSession) {
      sessId = `sess_${now}_${Math.random().toString(36).substring(2, 7)}`;
      const title = user_prompt.slice(0, 40) + (user_prompt.length > 40 ? "..." : "");
      await env.DB.prepare(
        `INSERT INTO sessions (id, title, target_repo, target_branch, custom_env_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(sessId, title, target_repo.trim(), target_branch.trim(), custom_env_json, now, now).run();
    } else {
      await env.DB.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).bind(now, sessId).run();
    }
    const runId = `run_${now}_${Math.random().toString(36).substring(2, 7)}`;
    await env.DB.prepare(
      `INSERT INTO runs (id, session_id, target_repo, target_branch, user_prompt, execution_mode, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`
    ).bind(runId, sessId, target_repo.trim(), target_branch.trim(), user_prompt.trim(), execution_mode, now).run();
    await env.DB.prepare(
      `INSERT INTO messages (session_id, run_id, role, type, content, timestamp) VALUES (?, ?, 'user', 'message', ?, ?)`
    ).bind(sessId, runId, user_prompt.trim(), now).run();
    const controlRepo = env.CONTROL_REPO || "owner/avos-agent-core";
    const streamUrl = `${new URL(request.url).origin}/api/events`;
    const ghRes = await fetch(`https://api.github.com/repos/${controlRepo}/actions/workflows/agent.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.USER_GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "AVOS-ControlPlane",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          target_repo: target_repo.trim(),
          target_branch: target_branch.trim(),
          user_prompt: user_prompt.trim(),
          session_id: String(sessId),
          execution_mode: String(execution_mode),
          max_workers: String(max_workers),
          max_budget_tokens: String(max_budget_tokens),
          create_pr: String(create_pr),
          ui_secret: String(ui_secret),
          run_id: String(runId),
          cf_stream_url: String(streamUrl),
          custom_env_json: String(custom_env_json)
        }
      })
    });
    if (!ghRes.ok) {
      const err = await ghRes.text();
      await env.DB.prepare(`UPDATE runs SET status = 'failed', summary = ? WHERE id = ?`).bind(`GitHub Dispatch Failed: ${err}`, runId).run();
      return new Response(JSON.stringify({ error: `GitHub API error: ${err}` }), { status: 502, headers: jsonHeaders });
    }
    return new Response(JSON.stringify({ success: true, runId, sessionId: sessId }), { headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
  }
}
__name(onRequestPost, "onRequestPost");

// api/events.js
async function onRequestPost2(context) {
  const { request, env } = context;
  const jsonHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  try {
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token || token !== env.AGENT_UI_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized emitter" }), { status: 401, headers: jsonHeaders });
    }
    const body = await request.json().catch(() => null);
    if (!body || !body.runId) {
      return new Response(JSON.stringify({ error: "Missing runId" }), { status: 400, headers: jsonHeaders });
    }
    const { runId } = body;
    const rawEvents = Array.isArray(body.events) ? body.events : body.event ? [body.event] : [];
    if (rawEvents.length === 0) {
      return new Response(JSON.stringify({ ok: true, processed: 0 }), { status: 200, headers: jsonHeaders });
    }
    const runRecord = await env.DB.prepare(`SELECT session_id FROM runs WHERE id = ?`).bind(runId).first();
    const sessionId = runRecord?.session_id || null;
    const statements = [];
    const now = Date.now();
    for (const ev of rawEvents) {
      const timestamp = ev.timestamp || now;
      const type = ev.type || "unknown";
      const agentId = ev.agentId || "AGENT";
      const payloadObj = ev.data || {};
      const payloadJson = JSON.stringify(payloadObj);
      statements.push(
        env.DB.prepare(
          `INSERT INTO events (run_id, session_id, timestamp, type, agent_id, payload_json)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(runId, sessionId, timestamp, type, agentId, payloadJson)
      );
      if (type === "completed") {
        statements.push(
          env.DB.prepare(`UPDATE runs SET status = 'completed', finished_at = ?, summary = ? WHERE id = ?`).bind(timestamp, payloadObj.summary || "Task completed.", runId)
        );
        if (sessionId) {
          statements.push(
            env.DB.prepare(`INSERT INTO messages (session_id, run_id, role, type, content, timestamp) VALUES (?, ?, 'assistant', 'final', ?, ?)`).bind(sessionId, runId, payloadObj.summary || "Task completed successfully.", timestamp)
          );
        }
      } else if (type === "error") {
        statements.push(
          env.DB.prepare(`UPDATE runs SET status = 'failed', finished_at = ?, summary = ? WHERE id = ?`).bind(timestamp, payloadObj.error || payloadObj.message || "Failed.", runId)
        );
        if (sessionId) {
          statements.push(
            env.DB.prepare(`INSERT INTO messages (session_id, run_id, role, type, content, timestamp) VALUES (?, ?, 'assistant', 'error', ?, ?)`).bind(sessionId, runId, `\u274C Error: ${payloadObj.error || payloadObj.message || "Execution failed."}`, timestamp)
          );
        }
      }
    }
    if (statements.length > 0) {
      await env.DB.batch(statements);
    }
    return new Response(JSON.stringify({ ok: true, processed: rawEvents.length }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
  }
}
__name(onRequestPost2, "onRequestPost");

// api/sessions.js
async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("id");
  const jsonHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  try {
    if (!env.DB) {
      return new Response(JSON.stringify({ error: "Missing D1 database binding 'DB'" }), { status: 500, headers: jsonHeaders });
    }
    if (sessionId) {
      const session = await env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(sessionId).first();
      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), { status: 404, headers: jsonHeaders });
      }
      const { results: messages } = await env.DB.prepare(
        `SELECT role, type, content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC`
      ).bind(sessionId).all();
      const { results: events } = await env.DB.prepare(
        `SELECT id, run_id, timestamp, type, agent_id, payload_json
         FROM events
         WHERE session_id = ?
         ORDER BY id ASC`
      ).bind(sessionId).all();
      const latestRun = await env.DB.prepare(
        `SELECT id, status, summary, created_at, finished_at FROM runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`
      ).bind(sessionId).first();
      return new Response(JSON.stringify({
        session,
        messages: messages || [],
        events: events || [],
        latestRun: latestRun || null
      }), { headers: jsonHeaders });
    }
    const { results: sessions } = await env.DB.prepare(
      `SELECT id, title, target_repo, target_branch, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50`
    ).all();
    return new Response(JSON.stringify({ sessions: sessions || [] }), { headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
  }
}
__name(onRequestGet, "onRequestGet");

// api/stream.js
async function onRequestGet2(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
  const runId = url.searchParams.get("runId");
  if (!runId) {
    return new Response(JSON.stringify({ error: "Missing required query parameter: 'runId'." }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "Server Configuration Error: D1 binding 'DB' is missing." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
  const initialFromId = parseInt(
    url.searchParams.get("fromId") || request.headers.get("Last-Event-ID") || "0",
    10
  );
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  (async () => {
    let lastSeqId = isNaN(initialFromId) ? 0 : initialFromId;
    let isActive = true;
    let consecutiveIdleCycles = 0;
    const maxIdleCyclesAfterTerminal = 3;
    try {
      while (isActive) {
        if (request.signal.aborted) {
          isActive = false;
          break;
        }
        const queryRes = await env.DB.prepare(
          `SELECT id, timestamp, type, agent_id, payload_json 
           FROM events 
           WHERE run_id = ? AND id > ? 
           ORDER BY id ASC 
           LIMIT 100`
        ).bind(runId, lastSeqId).all();
        const rows = queryRes.results || [];
        if (rows.length > 0) {
          consecutiveIdleCycles = 0;
          for (const row of rows) {
            lastSeqId = row.id;
            let parsedPayload = {};
            try {
              parsedPayload = JSON.parse(row.payload_json);
            } catch {
              parsedPayload = { raw: row.payload_json };
            }
            const sseEvent = {
              id: row.id,
              timestamp: row.timestamp,
              type: row.type,
              agentId: row.agent_id,
              data: parsedPayload
            };
            const payloadString = `id: ${row.id}
event: message
data: ${JSON.stringify(sseEvent)}

`;
            await writer.write(encoder.encode(payloadString));
            if (row.type === "completed" || row.type === "error") {
              isActive = false;
              break;
            }
          }
        } else {
          consecutiveIdleCycles++;
          await writer.write(encoder.encode(`: keep-alive ${Date.now()}

`));
          const runRecord = await env.DB.prepare(
            `SELECT status, summary FROM runs WHERE id = ?`
          ).bind(runId).first();
          if (runRecord) {
            if (runRecord.status === "completed" || runRecord.status === "failed") {
              if (consecutiveIdleCycles >= maxIdleCyclesAfterTerminal) {
                const terminalPayload = {
                  type: runRecord.status === "completed" ? "completed" : "error",
                  agentId: "ORCHESTRATOR",
                  data: {
                    summary: runRecord.summary || `Run terminated with status: ${runRecord.status}`
                  }
                };
                await writer.write(encoder.encode(`event: message
data: ${JSON.stringify(terminalPayload)}

`));
                isActive = false;
              }
            }
          }
        }
        if (isActive) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
    } catch (err) {
      try {
        const errorEvent = `event: message
data: ${JSON.stringify({ type: "error", agentId: "STREAM_PUMP", data: { error: err.message } })}

`;
        await writer.write(encoder.encode(errorEvent));
      } catch (_) {
      }
    } finally {
      try {
        await writer.close();
      } catch (_) {
      }
    }
  })();
  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      // Disable buffering on intermediate proxies
      ...corsHeaders
    }
  });
}
__name(onRequestGet2, "onRequestGet");
async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400"
    }
  });
}
__name(onRequestOptions, "onRequestOptions");

// ../.wrangler/tmp/pages-G1VZqD/functionsRoutes-0.11525518491282583.mjs
var routes = [
  {
    routePath: "/api/dispatch",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost]
  },
  {
    routePath: "/api/events",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost2]
  },
  {
    routePath: "/api/sessions",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  },
  {
    routePath: "/api/stream",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet2]
  },
  {
    routePath: "/api/stream",
    mountPath: "/api",
    method: "OPTIONS",
    middlewares: [],
    modules: [onRequestOptions]
  }
];

// ../../../home/codespace/.npm/_npx/32026684e21afda6/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../home/codespace/.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
