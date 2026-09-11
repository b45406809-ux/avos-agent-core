import { onRequestOptions as __api_dispatch_js_onRequestOptions } from "/workspaces/avos-agent-core/functions/api/dispatch.js"
import { onRequestPost as __api_dispatch_js_onRequestPost } from "/workspaces/avos-agent-core/functions/api/dispatch.js"
import { onRequestOptions as __api_events_js_onRequestOptions } from "/workspaces/avos-agent-core/functions/api/events.js"
import { onRequestPost as __api_events_js_onRequestPost } from "/workspaces/avos-agent-core/functions/api/events.js"
import { onRequestGet as __api_stream_js_onRequestGet } from "/workspaces/avos-agent-core/functions/api/stream.js"
import { onRequestOptions as __api_stream_js_onRequestOptions } from "/workspaces/avos-agent-core/functions/api/stream.js"

export const routes = [
    {
      routePath: "/api/dispatch",
      mountPath: "/api",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_dispatch_js_onRequestOptions],
    },
  {
      routePath: "/api/dispatch",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_dispatch_js_onRequestPost],
    },
  {
      routePath: "/api/events",
      mountPath: "/api",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_events_js_onRequestOptions],
    },
  {
      routePath: "/api/events",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_events_js_onRequestPost],
    },
  {
      routePath: "/api/stream",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_stream_js_onRequestGet],
    },
  {
      routePath: "/api/stream",
      mountPath: "/api",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_stream_js_onRequestOptions],
    },
  ]