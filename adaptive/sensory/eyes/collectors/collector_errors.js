/**
 * adaptive/sensory/eyes/collectors/collector_errors.js
 *
 * Shared deterministic error typing for eye collectors.
 */

function httpStatusToCode(status) {
  const s = Number(status || 0);
  if (!Number.isFinite(s) || s <= 0) return "http_error";
  if (s === 401) return "auth_unauthorized";
  if (s === 403) return "auth_forbidden";
  if (s === 404) return "http_404";
  if (s === 408) return "timeout";
  if (s === 429) return "rate_limited";
  if (s >= 500) return "http_5xx";
  if (s >= 400) return "http_4xx";
  return "http_error";
}

function normalizeNodeCode(code) {
  const c = String(code || "").toLowerCase();
  if (!c) return "";
  if (
    c === "auth_missing" ||
    c === "auth_unauthorized" ||
    c === "auth_forbidden" ||
    c === "env_blocked" ||
    c === "dns_unreachable" ||
    c === "connection_refused" ||
    c === "connection_reset" ||
    c === "timeout" ||
    c === "tls_error" ||
    c === "rate_limited" ||
    c === "http_4xx" ||
    c === "http_404" ||
    c === "http_5xx" ||
    c === "http_error" ||
    c === "network_error" ||
    c === "endpoint_unsupported"
  ) return c;
  if (c === "enotfound" || c === "eai_again") return "dns_unreachable";
  if (c === "eperm") return "env_blocked";
  if (c === "econnrefused") return "connection_refused";
  if (c === "econnreset") return "connection_reset";
  if (c === "etimedout" || c === "esockettimedout") return "timeout";
  if (c.includes("cert") || c.includes("ssl") || c.includes("tls")) return "tls_error";
  if (c === "unauthorized") return "auth_unauthorized";
  if (c === "forbidden") return "auth_forbidden";
  return "";
}

function parseHttpStatusFromMessage(msg) {
  const s = String(msg || "");
  const m = s.match(/\bhttp\s+(\d{3})\b/i);
  if (!m) return null;
  const status = Number(m[1]);
  return Number.isFinite(status) ? status : null;
}

function classifyMessage(msg) {
  const s = String(msg || "").toLowerCase();
  if (!s) return "";
  if (s.includes("missing_moltbook_api_key")) return "auth_missing";
  if (s.includes("missing api key")) return "auth_missing";
  if (s.includes("unauthorized")) return "auth_unauthorized";
  if (s.includes("forbidden")) return "auth_forbidden";
  if (s.includes("enotfound") || s.includes("getaddrinfo") || s.includes("dns") || s.includes("eai_again")) return "dns_unreachable";
  if (s.includes("operation not permitted") || s.includes("permission denied")) return "env_blocked";
  if (s.includes("econnrefused") || s.includes("connection refused")) return "connection_refused";
  if (s.includes("econnreset")) return "connection_reset";
  if (s.includes("timed out") || s.includes("timeout") || s.includes("etimedout")) return "timeout";
  if (s.includes("ssl") || s.includes("tls") || s.includes("certificate")) return "tls_error";
  const status = parseHttpStatusFromMessage(s);
  if (status != null) return httpStatusToCode(status);
  return "";
}

function makeCollectorError(code, message, meta = {}) {
  const err = new Error(String(message || code || "collector_error"));
  err.code = String(code || "collector_error");
  if (meta && typeof meta === "object") {
    for (const [k, v] of Object.entries(meta)) err[k] = v;
  }
  return err;
}

function isTransportFailureCode(code) {
  const c = String(code || "").toLowerCase();
  return (
    c === "env_blocked" ||
    c === "dns_unreachable" ||
    c === "connection_refused" ||
    c === "connection_reset" ||
    c === "timeout" ||
    c === "tls_error" ||
    c === "http_4xx" ||
    c === "http_404" ||
    c === "http_5xx" ||
    c === "rate_limited" ||
    c === "http_error"
  );
}

function isRetryableCode(code) {
  const c = String(code || "").toLowerCase();
  return (
    c === "env_blocked" ||
    c === "dns_unreachable" ||
    c === "connection_refused" ||
    c === "connection_reset" ||
    c === "timeout" ||
    c === "http_5xx" ||
    c === "rate_limited" ||
    c === "http_error"
  );
}

function classifyCollectorError(err) {
  const message = String((err && err.message) || err || "unknown_error").slice(0, 200);
  const statusFromErr = Number((err && (err.http_status || err.status)) || 0);
  const statusFromMsg = parseHttpStatusFromMessage(message);
  const httpStatus = Number.isFinite(statusFromErr) && statusFromErr > 0
    ? statusFromErr
    : statusFromMsg;

  let code = normalizeNodeCode(err && err.code);
  if (!code && httpStatus != null) code = httpStatusToCode(httpStatus);
  if (!code) code = classifyMessage(message);
  if (!code) code = "collector_error";

  return {
    code,
    message,
    http_status: httpStatus == null ? null : Number(httpStatus),
    transport: isTransportFailureCode(code),
    retryable: isRetryableCode(code)
  };
}

module.exports = {
  classifyCollectorError,
  httpStatusToCode,
  isRetryableCode,
  isTransportFailureCode,
  makeCollectorError
};
