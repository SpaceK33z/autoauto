import { describe, it, expect } from "bun:test"
import { classifyAgentError, buildAgentErrorEvent } from "./error-classifier.ts"

describe("classifyAgentError", () => {
  // --- Quota exhaustion ---
  describe("quota_exhausted", () => {
    const cases = [
      // Claude subscription
      "You've hit your limit · resets Tuesday at 11:00 AM",
      "You've hit your extra usage spend limit",
      "API Error: Rate limit reached\nYou've hit your extra usage spend limit",
      // Codex subscription
      "You've hit your usage limit. Upgrade to Pro or try again at Feb 23rd.",
      // OpenAI API
      "You exceeded your current quota, please check your plan and billing details.",
      // OpenAI error code
      '{"error":{"message":"quota exceeded","type":"insufficient_quota","code":"insufficient_quota"}}',
      // OpenCode
      "Subscription quota exceeded. You can continue using free models.",
      "quota_exceeded",
      "billing_hard_limit",
      "out of credits",
    ]

    for (const msg of cases) {
      it(`detects: ${msg.slice(0, 60)}...`, () => {
        expect(classifyAgentError(msg)).toBe("quota_exhausted")
      })
    }
  })

  // --- Rate limited ---
  describe("rate_limited", () => {
    const cases = [
      "API Error: Rate limit reached",
      "Rate limit reached for gpt-5.2-codex in organization org-XXX on tokens per min (TPM): Limit 500000",
      "rate_limit_exceeded",
      "exceeded retry limit, last status: 429 Too Many Requests, request id: abc123",
      "stream disconnected before completion: Rate limit reached for organization org-XXX on tokens per min (TPM)",
      "Error code: status 429 - Too Many Requests",
    ]

    for (const msg of cases) {
      it(`detects: ${msg.slice(0, 60)}...`, () => {
        expect(classifyAgentError(msg)).toBe("rate_limited")
      })
    }
  })

  // --- Auth errors ---
  describe("auth_error", () => {
    const cases = [
      "Unauthorized",
      "Forbidden",
      "Invalid API key provided",
      "invalid_api_key",
      "not authenticated",
      "authentication_error",
    ]

    for (const msg of cases) {
      it(`detects: ${msg.slice(0, 60)}...`, () => {
        expect(classifyAgentError(msg)).toBe("auth_error")
      })
    }
  })

  // --- Generic ---
  describe("generic", () => {
    it("returns generic for unknown errors", () => {
      expect(classifyAgentError("Something went wrong")).toBe("generic")
    })

    it("returns generic for empty string", () => {
      expect(classifyAgentError("")).toBe("generic")
    })

    it("returns generic for null", () => {
      expect(classifyAgentError(null)).toBe("generic")
    })

    it("returns generic for undefined", () => {
      expect(classifyAgentError(undefined)).toBe("generic")
    })
  })

  // --- JSON unwrapping ---
  describe("JSON unwrapping", () => {
    it("unwraps JSON-stringified quota error objects", () => {
      const json = JSON.stringify({
        error: { code: "insufficient_quota", message: "You have exceeded your quota" },
      })
      expect(classifyAgentError(json)).toBe("quota_exhausted")
    })

    it("unwraps JSON-stringified rate limit error objects", () => {
      const json = JSON.stringify({
        statusCode: 429,
        error: "Too Many Requests",
      })
      expect(classifyAgentError(json)).toBe("rate_limited")
    })

    it("unwraps JSON-stringified string values", () => {
      const json = JSON.stringify("Subscription quota exceeded")
      expect(classifyAgentError(json)).toBe("quota_exhausted")
    })

    it("handles non-JSON strings normally", () => {
      expect(classifyAgentError("not json at all")).toBe("generic")
    })

    it("handles nested JSON objects", () => {
      const json = JSON.stringify({
        data: { inner: { message: "billing_hard_limit reached" } },
      })
      expect(classifyAgentError(json)).toBe("quota_exhausted")
    })
  })

  // --- Priority order ---
  describe("priority", () => {
    it("quota wins over rate limit when both match", () => {
      // A message containing both quota and rate-limit language
      expect(classifyAgentError("Rate limit reached: you've hit your limit")).toBe("quota_exhausted")
    })

    it("rate_limited wins over auth when both match", () => {
      expect(classifyAgentError("unauthorized rate limit exceeded")).toBe("rate_limited")
    })
  })

  // --- Case insensitivity ---
  describe("case insensitivity", () => {
    it("matches uppercase quota errors", () => {
      expect(classifyAgentError("YOU'VE HIT YOUR LIMIT")).toBe("quota_exhausted")
    })

    it("matches mixed case rate limit errors", () => {
      expect(classifyAgentError("Rate Limit Reached")).toBe("rate_limited")
    })
  })
})

describe("buildAgentErrorEvent", () => {
  it("builds quota_exhausted event with retriable: false", () => {
    const event = buildAgentErrorEvent("You've hit your limit")
    expect(event).toEqual({
      type: "error",
      error: "You've hit your limit",
      retriable: false,
      errorKind: "quota_exhausted",
    })
  })

  it("builds rate_limited event with retriable: true", () => {
    const event = buildAgentErrorEvent("Rate limit reached")
    expect(event).toEqual({
      type: "error",
      error: "Rate limit reached",
      retriable: true,
      errorKind: "rate_limited",
    })
  })

  it("builds generic event with retriable: false", () => {
    const event = buildAgentErrorEvent("Something broke")
    expect(event).toEqual({
      type: "error",
      error: "Something broke",
      retriable: false,
      errorKind: "generic",
    })
  })
})
