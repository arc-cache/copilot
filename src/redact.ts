const SECRET_ASSIGNMENT_RE =
  /(["']?(?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY)["']?\s*[:=]\s*)["']?[^"'\s,}]+["']?/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>)]*/gi, "<url>")
    .replace(/\b(?:10|127)\.(?:\d{1,3}\.){2}\d{1,3}\b/g, "<private-ip>")
    .replace(/\b192\.168\.\d{1,3}\.\d{1,3}\b/g, "<private-ip>")
    .replace(/\b172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}\b/g, "<private-ip>")
    .replace(/\b169\.254\.\d{1,3}\.\d{1,3}\b/g, "<private-ip>")
    .replace(/\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g, "<mac-address>")
    .replace(/\bglpat-[A-Za-z0-9_=-]{12,}\b/g, "<token>")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_=-]{12,}\b/g, "<token>")
    .replace(/\bgithub_pat_[A-Za-z0-9_=-]{12,}\b/g, "<token>")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, "<token>")
    .replace(/\b(?:bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "<token>")
    .replace(SECRET_ASSIGNMENT_RE, "$1<token>")
    .replace(/\/Users\/[^/\s"'<>]+/g, "<home>")
    .replace(/\/home\/[^/\s"'<>]+/g, "<home>");
}

export function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactJson(item);
    }
    return out;
  }
  return value;
}
