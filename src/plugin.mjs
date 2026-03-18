/**
 * NanoProxy OpenCode Plugin (Experimental)
 *
 * Patches globalThis.fetch to intercept NanoGPT API calls and apply the
 * tool bridge protocol transparently.
 *
 * WARNING: This is experimental. For production use, prefer the standalone
 * server mode which is more battle-tested.
 *
 * Requests with tools are rewritten to use the text-based bridge protocol,
 * and responses are converted back to native tool_calls format.
 *
 * Streaming is handled progressively - reasoning streams live, and tool
 * calls are emitted as individual deltas when complete envelopes are detected.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = dirname(__dirname)
const DEBUG_FLAG_FILE = join(REPO_ROOT, ".debug-logging")

export const NanoProxyPlugin = async function NanoProxyPlugin(ctx) {
  let core
  try {
    core = await import(pathToFileURL(join(__dirname, "core.js")).href)
  } catch (e) {
    return {}
  }

  if (!core || typeof core !== "object") {
    return {}
  }

  const requestNeedsBridge = core.requestNeedsBridge
  const transformRequestForBridge = core.transformRequestForBridge
  const tryParseJson = core.tryParseJson
  const acceptNativeJson = core.acceptNativeJson
  const acceptNativeSSE = core.acceptNativeSSE
  const buildChatCompletionFromBridge = core.buildChatCompletionFromBridge
  const buildBridgeResultFromText = core.buildBridgeResultFromText
  const generateToolCallId = core.generateToolCallId
  const applyChunkToAggregate = core.applyChunkToAggregate
  const extractProgressiveToolCalls = core.extractProgressiveToolCalls
  const extractCallEnvelopes = core.extractCallEnvelopes
  const extractStreamableFinalContent = core.extractStreamableFinalContent
  const MAX_TOOL_CALLS_PER_TURN = core.MAX_TOOL_CALLS_PER_TURN
  const buildToolArgumentKeyMap = core.buildToolArgumentKeyMap
  const buildToolRequiredKeyMap = core.buildToolRequiredKeyMap
  const buildInvalidToolBlockRecoveryRequest = core.buildInvalidToolBlockRecoveryRequest

  if (typeof requestNeedsBridge !== "function" || typeof transformRequestForBridge !== "function") {
    return {}
  }


  const LOG_FILE = process.env.NANOPROXY_LOG || join(tmpdir(), "nanoproxy-plugin.log")
  const LOG_DIR = process.env.NANOPROXY_LOG_DIR || join(tmpdir(), "nanoproxy-plugin-logs")
  const VERBOSE =
    process.env.NANOPROXY_DEBUG === "1" ||
    process.env.NANOPROXY_DEBUG === "true" ||
    existsSync(DEBUG_FLAG_FILE)

  if (VERBOSE) {
    try {
      mkdirSync(LOG_DIR, { recursive: true })
    } catch (e) {}
  }

  function log(obj) {
    try {
      appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n")
    } catch (e) {}
  }

  function dbg(obj) {
    if (!VERBOSE) return
    log(obj)
  }

  function makeRequestId() {
    return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 10)}`
  }

  function writeDebugFile(name, content) {
    if (!VERBOSE) return
    try {
      writeFileSync(join(LOG_DIR, name), content)
    } catch (e) {}
  }

  function appendDebugFile(name, content) {
    if (!VERBOSE) return
    try {
      appendFileSync(join(LOG_DIR, name), content)
    } catch (e) {}
  }

  function writeDebugJson(name, value) {
    writeDebugFile(name, JSON.stringify(value, null, 2))
  }


  function sanitizeBufferedResponseHeaders(headersLike, bodyLength, contentTypeOverride) {
    const headers = new Headers(headersLike || {})
    headers.delete("content-length")
    headers.delete("content-encoding")
    headers.delete("transfer-encoding")
    if (contentTypeOverride) headers.set("content-type", contentTypeOverride)
    if (bodyLength !== undefined) headers.set("content-length", String(bodyLength))
    return headers
  }

  log({ event: "init", pid: process.pid, fetch: typeof globalThis.fetch, verbose: VERBOSE, debugEnv: process.env.NANOPROXY_DEBUG })

  const originalFetch = globalThis.fetch
  const encoder = new TextEncoder()
  const SSE_HEARTBEAT_INTERVAL_MS = 15000

  function sseLine(payload) {
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  async function processStreamingResponse(response, dbgData, parseOptions = {}, onInvalidToolBlockRetry = null) {
    let reader = response.body.getReader()
    let invalidRetryUsed = false
    let droppedCallsRetryUsed = false
    const decoder = new TextDecoder()

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()

    const aggregate = {
      id: null,
      model: null,
      created: null,
      reasoning: "",
      content: "",
      finishReason: null,
      usage: undefined
    }

    let rawBuffer = ""
    let reasoningSent = 0
    let finalContentSent = 0
    let emittedToolCallCount = 0
    const rawSseFile = `${dbgData.requestId}-stream.sse`
    let streamClosed = false
    let lastDownstreamWriteAt = Date.now()

    const writeChunk = async (text) => {
      if (streamClosed) return
      lastDownstreamWriteAt = Date.now()
      await writer.write(encoder.encode(text))
    }

    const heartbeatTimer = setInterval(async () => {
      if (streamClosed) return
      if (Date.now() - lastDownstreamWriteAt < SSE_HEARTBEAT_INTERVAL_MS) return
      try {
        await writeChunk(": keepalive\n\n")
      } catch {}
    }, SSE_HEARTBEAT_INTERVAL_MS)

    const stopHeartbeat = () => {
      clearInterval(heartbeatTimer)
    }

    const flushReasoningDelta = async () => {
      if (aggregate.reasoning.length <= reasoningSent) return
      const deltaText = aggregate.reasoning.slice(reasoningSent)
      reasoningSent = aggregate.reasoning.length
      await writeChunk(sseLine({
        id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
        object: "chat.completion.chunk",
        created: aggregate.created || Math.floor(Date.now() / 1000),
        model: aggregate.model || "tool-bridge",
        choices: [{ index: 0, delta: { reasoning: deltaText }, finish_reason: null }]
      }))
    }

    const flushFinalContentDelta = async () => {
      // Only start streaming once we've confirmed this is a final answer,
      // not a tool call. We wait until [[OPENCODE_FINAL]] appears in the buffer
      // so we never accidentally stream raw [[OPENCODE_TOOL]] envelope text.
      if (!aggregate.content.includes("OPENCODE_FINAL")) return
      const streamable = extractStreamableFinalContent(aggregate.content)
      if (!streamable || streamable.length <= finalContentSent) return
      const deltaText = streamable.slice(finalContentSent)
      finalContentSent = streamable.length
      await writeChunk(sseLine({
        id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
        object: "chat.completion.chunk",
        created: aggregate.created || Math.floor(Date.now() / 1000),
        model: aggregate.model || "tool-bridge",
        choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }]
      }))
    }

    const flushProgressiveToolCallsFunc = async () => {
      const calls = extractProgressiveToolCalls(aggregate.content, parseOptions)
      if (calls.length <= emittedToolCallCount) return
      dbg({ ...dbgData, event: "stream_progressive_calls", total: calls.length, new: calls.length - emittedToolCallCount, source: "content" })
      for (let i = emittedToolCallCount; i < calls.length; i++) {
        const call = calls[i]
        await writeChunk(sseLine({
          id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
          object: "chat.completion.chunk",
          created: aggregate.created || Math.floor(Date.now() / 1000),
          model: aggregate.model || "tool-bridge",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: i,
                id: call.id,
                type: "function",
                function: { name: call.function.name, arguments: call.function.arguments }
              }]
            },
            finish_reason: null
          }]
        }))
      }
      emittedToolCallCount = calls.length
    }

    const finalizeAsToolCalls = async () => {
      await writeChunk(sseLine({
        id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
        object: "chat.completion.chunk",
        created: aggregate.created || Math.floor(Date.now() / 1000),
        model: aggregate.model || "tool-bridge",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        ...(aggregate.usage ? { usage: aggregate.usage } : {})
      }))
      await writeChunk("data: [DONE]\n\n")
      streamClosed = true
      stopHeartbeat()
      await writer.close()
    }

    ;(async () => {
      let cappedAtToolLimit = false
      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            let result = buildBridgeResultFromText(aggregate.content, aggregate.reasoning, parseOptions)
            log({ ...dbgData, event: "stream_done", kind: result.kind })
            dbg({ ...dbgData, event: "stream_raw_content", content: aggregate.content, reasoning: aggregate.reasoning.slice(0, 200) })
            if (result.kind === "invalid_tool_block" && !invalidRetryUsed && typeof onInvalidToolBlockRetry === "function") {
              dbg({ ...dbgData, event: "stream_invalid_tool_block_retry" })
              const retryResponse = await onInvalidToolBlockRetry()
              if (retryResponse && (retryResponse.headers.get("content-type") || "").includes("text/event-stream")) {
                invalidRetryUsed = true
                reader = retryResponse.body.getReader()
                rawBuffer = ""
                reasoningSent = 0
                finalContentSent = 0
                emittedToolCallCount = 0
                aggregate.id = null
                aggregate.model = null
                aggregate.created = null
                aggregate.reasoning = ""
                aggregate.content = ""
                aggregate.finishReason = null
                aggregate.usage = undefined
                continue
              }
            }
            let rawClosedCallCount = 0
            let parsedCallCount = result.kind === "tool_calls"
              ? (result.message.tool_calls || []).length
              : 0
            try {
              rawClosedCallCount = typeof extractCallEnvelopes === "function"
                ? extractCallEnvelopes(aggregate.content, false, false).length
                : 0
              if (rawClosedCallCount > parsedCallCount) {
                dbg({
                  ...dbgData,
                  event: "stream_dropped_calls_suspected",
                  rawClosedCallCount,
                  parsedCallCount
                })
              }
            } catch (e) {}
            if (rawClosedCallCount > parsedCallCount && !droppedCallsRetryUsed && typeof onInvalidToolBlockRetry === "function") {
              dbg({
                ...dbgData,
                event: "stream_dropped_calls_retry",
                rawClosedCallCount,
                parsedCallCount
              })
              const retryResponse = await onInvalidToolBlockRetry()
              if (retryResponse && (retryResponse.headers.get("content-type") || "").includes("text/event-stream")) {
                droppedCallsRetryUsed = true
                reader = retryResponse.body.getReader()
                rawBuffer = ""
                reasoningSent = 0
                finalContentSent = 0
                emittedToolCallCount = 0
                aggregate.id = null
                aggregate.model = null
                aggregate.created = null
                aggregate.reasoning = ""
                aggregate.content = ""
                aggregate.finishReason = null
                aggregate.usage = undefined
                continue
              }
            }
            writeDebugJson(`${dbgData.requestId}-response.json`, {
              requestId: dbgData.requestId,
              kind: result.kind,
              finishReason: aggregate.finishReason,
              aggregate,
              parsedResult: result,
            })

            if (result.kind === "tool_calls") {
              const allCalls = result.message.tool_calls || []
              for (let i = emittedToolCallCount; i < allCalls.length; i++) {
                const call = allCalls[i]
                await writeChunk(sseLine({
                  id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
                  object: "chat.completion.chunk",
                  created: aggregate.created || Math.floor(Date.now() / 1000),
                  model: aggregate.model || "tool-bridge",
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: i,
                        id: call.id,
                        type: "function",
                        function: { name: call.function.name, arguments: call.function.arguments }
                      }]
                    },
                    finish_reason: null
                  }]
                }))
              }
              await writeChunk(sseLine({
                id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
                object: "chat.completion.chunk",
                created: aggregate.created || Math.floor(Date.now() / 1000),
                model: aggregate.model || "tool-bridge",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                ...(aggregate.usage ? { usage: aggregate.usage } : {})
              }))
            } else {
              // Flush any remaining final content not yet streamed progressively
              await flushFinalContentDelta()
              const fullFinal = extractStreamableFinalContent(aggregate.content) || result.message.content || ""
              const remaining = fullFinal.slice(finalContentSent)
              if (remaining) {
                await writeChunk(sseLine({
                  id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
                  object: "chat.completion.chunk",
                  created: aggregate.created || Math.floor(Date.now() / 1000),
                  model: aggregate.model || "tool-bridge",
                  choices: [{ index: 0, delta: { content: remaining }, finish_reason: null }]
                }))
              }
              await writeChunk(sseLine({
                id: aggregate.id || `chatcmpl_${generateToolCallId()}`,
                object: "chat.completion.chunk",
                created: aggregate.created || Math.floor(Date.now() / 1000),
                model: aggregate.model || "tool-bridge",
                choices: [{ index: 0, delta: {}, finish_reason: aggregate.finishReason || "stop" }],
                ...(aggregate.usage ? { usage: aggregate.usage } : {})
              }))
            }

            await writeChunk("data: [DONE]\n\n")
            streamClosed = true
            stopHeartbeat()
            await writer.close()
            break
          }

          rawBuffer += decoder.decode(value, { stream: true })
          let boundary
          while ((boundary = rawBuffer.indexOf("\n\n")) !== -1) {
            const eventText = rawBuffer.slice(0, boundary)
            rawBuffer = rawBuffer.slice(boundary + 2)
            const line = eventText
              .split(/\r?\n/)
              .map(p => p.trim())
              .find(p => p.startsWith("data:"))
            if (!line) continue
            appendDebugFile(rawSseFile, eventText + "\n\n")
            const payload = line.slice(5).trim()
            if (!payload || payload === "[DONE]") continue
            const parsed = tryParseJson(payload)
            if (!parsed.ok) continue

            applyChunkToAggregate(aggregate, parsed.value)
            await flushReasoningDelta()
            await flushProgressiveToolCallsFunc()
            if (emittedToolCallCount >= MAX_TOOL_CALLS_PER_TURN) {
              cappedAtToolLimit = true
              dbg({ ...dbgData, event: "stream_tool_call_cap", count: emittedToolCallCount })
              try { await reader.cancel() } catch (e) {}
              break
            }
            await flushFinalContentDelta()
          }
          if (cappedAtToolLimit) {
            await finalizeAsToolCalls()
            break
          }
        }
      } catch (err) {
        dbg({ ...dbgData, event: "stream_error", error: err.message })
        try { await writer.abort(err) } catch (e) {}
      } finally {
        streamClosed = true
        stopHeartbeat()
      }
    })()

    return new Response(readable, {
      status: response.status,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      },
    })
  }

  globalThis.fetch = async function nanoproxyFetch(input, init, ...rest) {
    const urlStr = input instanceof Request ? input.url : String(input)

    if (!urlStr.includes("nano-gpt.com")) {
      return originalFetch(input, init, ...rest)
    }

    const requestId = makeRequestId()
    log({ event: "intercept", requestId, url: urlStr, method: init?.method ?? "GET" })

    const method = String(
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase()
    if (method !== "POST") {
      return originalFetch(input, init, ...rest)
    }

    const clonedRequest = input instanceof Request ? input.clone() : null

    let bodyText
    try {
      if (clonedRequest) {
        bodyText = await clonedRequest.text()
      } else if (init?.body != null) {
        const b = init.body
        if (typeof b === "string") {
          bodyText = b
        } else if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) {
          bodyText = new TextDecoder().decode(b)
        } else if (typeof b.text === "function") {
          bodyText = await b.text()
        } else {
          return originalFetch(input, init, ...rest)
        }
      } else {
        return originalFetch(input, init, ...rest)
      }
    } catch (e) {
      dbg({ event: "body_read_error", url: urlStr, error: e.message })
      return originalFetch(input, init, ...rest)
    }

    const parsed = tryParseJson(bodyText)
    const hasTools = !!(
      parsed.ok &&
      parsed.value &&
      typeof parsed.value === "object" &&
      Array.isArray(parsed.value.tools) &&
      parsed.value.tools.length > 0
    )

    if (!parsed.ok || !hasTools) {
      return originalFetch(input, init, ...rest)
    }

    const shouldBridgeImmediately = requestNeedsBridge(parsed.value)

    if (!shouldBridgeImmediately) {
      log({
        event: "native_first_attempt",
        requestId,
        url: urlStr,
        model: parsed.value.model,
        toolCount: parsed.value.tools?.length ?? 0,
      })

      const nativeResponse = await originalFetch(input, init, ...rest)
      const nativeContentType = nativeResponse.headers.get("content-type") ?? ""

      if (nativeContentType.includes("text/event-stream")) {
        const streamText = await nativeResponse.text()
        const nativeSucceeded = acceptNativeSSE(nativeResponse.status, streamText)
        dbg({
          event: "native_first_stream_result",
          requestId,
          status: nativeResponse.status,
          accepted: nativeSucceeded,
        })
        if (nativeSucceeded) {
          return new Response(streamText, {
            status: nativeResponse.status,
            headers: sanitizeBufferedResponseHeaders(
              nativeResponse.headers,
              Buffer.byteLength(streamText),
              "text/event-stream; charset=utf-8"
            ),
          })
        }
      } else if (nativeContentType.includes("application/json")) {
        const jsonText = await nativeResponse.text()
        const nativeParsed = tryParseJson(jsonText)
        const nativeSucceeded = nativeParsed.ok && acceptNativeJson(nativeResponse.status, nativeParsed.value)
        dbg({
          event: "native_first_json_result",
          requestId,
          status: nativeResponse.status,
          accepted: nativeSucceeded,
        })
        if (nativeSucceeded) {
          return new Response(jsonText, {
            status: nativeResponse.status,
            headers: sanitizeBufferedResponseHeaders(
              nativeResponse.headers,
              Buffer.byteLength(jsonText),
              "application/json; charset=utf-8"
            ),
          })
        }
      } else if (nativeResponse.status >= 200 && nativeResponse.status < 300) {
        const nativeBuffer = await nativeResponse.arrayBuffer()
        return new Response(nativeBuffer, {
          status: nativeResponse.status,
          headers: sanitizeBufferedResponseHeaders(nativeResponse.headers, nativeBuffer.byteLength),
        })
      }

      log({
        event: "native_first_fallback_to_bridge",
        requestId,
        url: urlStr,
        model: parsed.value.model,
      })
    }

    const transformed = transformRequestForBridge(parsed.value, { forceBridge: !shouldBridgeImmediately })
    const parseOptions = {
      toolArgKeyMap: buildToolArgumentKeyMap(Array.isArray(transformed.normalizedTools) ? transformed.normalizedTools : []),
      toolRequiredKeyMap: buildToolRequiredKeyMap(Array.isArray(transformed.normalizedTools) ? transformed.normalizedTools : [])
    }
    if (!transformed.bridgeApplied) {
      log({ event: "bridge_skipped", url: urlStr, reason: "no tools or no model match" })
      return originalFetch(input, init, ...rest)
    }

    log({
      event: "bridge_request",
      requestId,
      url: urlStr,
      model: parsed.value.model,
      toolCount: parsed.value.tools?.length ?? 0,
    })
    writeDebugJson(`${requestId}-request.json`, {
      requestId,
      url: urlStr,
      requestBodyOriginal: parsed.value,
      requestBodyRewritten: transformed.rewritten,
      bridgeApplied: transformed.bridgeApplied,
    })

    const newBodyText = JSON.stringify(transformed.rewritten)
    const newBodyBytes = new TextEncoder().encode(newBodyText)

    const headers = new Headers(input instanceof Request ? input.headers : {})
    if (init?.headers) {
      const initHeaders = new Headers(init.headers)
      for (const [k, v] of initHeaders) {
        headers.set(k, v)
      }
    }
    headers.set("content-type", "application/json")
    headers.set("content-length", String(newBodyBytes.length))

    const response = await originalFetch(urlStr, {
      ...init,
      method: "POST",
      headers,
      body: newBodyBytes,
    })

    const contentType = response.headers.get("content-type") ?? ""
    const dbgData = {
      requestId,
      url: urlStr,
      status: response.status,
      contentType,
    }

    dbg({ event: "bridge_response", ...dbgData })

    if (contentType.includes("text/event-stream")) {
      const retryInvalidToolBlock = async () => {
        const retryPayload = buildInvalidToolBlockRecoveryRequest(transformed.rewritten)
        const retryText = JSON.stringify(retryPayload)
        const retryBytes = new TextEncoder().encode(retryText)
        const retryHeaders = new Headers(headers)
        retryHeaders.set("content-length", String(retryBytes.length))
        return originalFetch(urlStr, {
          ...init,
          method: "POST",
          headers: retryHeaders,
          body: retryBytes,
        })
      }
      return processStreamingResponse(response, dbgData, parseOptions, retryInvalidToolBlock)
    }

    const responseText = await response.text()
    const responseParsed = tryParseJson(responseText)
    if (responseParsed.ok) {
      const v = responseParsed.value
      const choice = Array.isArray(v.choices) ? v.choices[0] : null
      const msg = choice?.message ?? {}
      const bridged = buildChatCompletionFromBridge({
        id: v.id,
        model: v.model,
        created: v.created,
        reasoning: msg.reasoning_content ?? "",
        content: msg.content ?? "",
        finishReason: choice?.finish_reason,
        usage: v.usage,
      }, parseOptions)
      dbg({ event: "bridge_json_rewritten", finishReason: choice?.finish_reason })
      writeDebugJson(`${requestId}-response.json`, {
        requestId,
        upstreamResponse: v,
        rewrittenResponse: bridged,
      })
      return new Response(JSON.stringify(bridged), {
        status: response.status,
        headers: { "content-type": "application/json" },
      })
    }

    dbg({ event: "bridge_passthrough", url: urlStr, reason: "response not parseable" })
    return new Response(responseText, {
      status: response.status,
      headers: response.headers,
    })
  }

  return {}
}

export default NanoProxyPlugin;




