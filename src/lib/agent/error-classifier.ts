/** Classification of agent errors for loop control. */
export type ErrorKind = "quota_exhausted" | "rate_limited" | "auth_error" | "generic"

// --- Patterns (checked in priority order) ---

const QUOTA_PATTERNS = [
  "you've hit your limit",
  "you've hit your usage limit",
  "extra usage spend limit",
  "exceeded your current quota",
  "insufficient_quota",
  "quota_exceeded",
  "quota exceeded",
  "subscription quota exceeded",
  "billing_hard_limit",
  "out of credits",
]

const RATE_LIMIT_PATTERNS = [
  "rate limit",
  "rate_limit",
  "too many requests",
  "exceeded retry limit",
  "status: 429",
  "status 429",
  "error 429",
  "code: 429",
  "code 429",
]

const AUTH_PATTERNS = [
  "unauthorized",
  "forbidden",
  "invalid api key",
  "invalid_api_key",
  "not authenticated",
  "authentication_error",
  "status: 401",
  "status 401",
  "error 401",
  "status: 403",
  "status 403",
  "error 403",
]

// --- JSON unwrapping ---

/** Recursively extract all string values from a parsed JSON value. */
function extractStrings(value: unknown, depth = 0): string[] {
  if (depth > 4) return []
  if (typeof value === "string") return [value]
  if (typeof value === "number" || typeof value === "boolean") return [String(value)]
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap((v) => extractStrings(v, depth + 1))
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((v) => extractStrings(v, depth + 1))
  }
  return []
}

/** Attempt to unwrap a JSON-stringified error into a flat string for matching. */
function unwrapJson(input: string): string {
  try {
    const parsed = JSON.parse(input)
    if (typeof parsed === "string") return parsed
    const strings = extractStrings(parsed)
    return strings.join(" ")
  } catch {
    return input
  }
}

// --- Classifier ---

/** Classify an error string into an ErrorKind for loop control decisions. */
export function classifyAgentError(error: string | undefined | null): ErrorKind {
  if (!error) return "generic"

  const raw = unwrapJson(error)
  const lower = raw.toLowerCase()

  // Priority: quota > rate_limit > auth > generic
  for (const pattern of QUOTA_PATTERNS) {
    if (lower.includes(pattern)) return "quota_exhausted"
  }
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (lower.includes(pattern)) return "rate_limited"
  }
  for (const pattern of AUTH_PATTERNS) {
    if (lower.includes(pattern)) return "auth_error"
  }

  return "generic"
}

/** Construct a typed error AgentEvent with classification and correct retriable flag. */
export function buildAgentErrorEvent(error: string): {
  type: "error"
  error: string
  retriable: boolean
  errorKind: ErrorKind
} {
  const errorKind = classifyAgentError(error)
  return {
    type: "error",
    error,
    retriable: errorKind === "rate_limited",
    errorKind,
  }
}
