import { describe, expect, test } from "bun:test"
import { extractFinalizeGroups, validateGroups } from "./finalize.ts"

describe("extractFinalizeGroups", () => {
  test("extracts valid groups", () => {
    const text = `Some review text here.
<finalize_groups>
[
  {
    "name": "lazy-load-images",
    "title": "perf(images): lazy-load below-fold images",
    "description": "Added intersection observer",
    "files": ["src/ImageLoader.tsx", "src/lazy.ts"],
    "risk": "low"
  },
  {
    "name": "remove-lodash",
    "title": "refactor: remove lodash dependency",
    "description": "Replaced with native methods",
    "files": ["package.json", "src/utils.ts"],
    "risk": "medium"
  }
]
</finalize_groups>
More text after.`

    const groups = extractFinalizeGroups(text)
    expect(groups).not.toBeNull()
    expect(groups!.length).toBe(2)
    expect(groups![0].name).toBe("lazy-load-images")
    expect(groups![0].files).toEqual(["src/ImageLoader.tsx", "src/lazy.ts"])
    expect(groups![0].risk).toBe("low")
    expect(groups![1].name).toBe("remove-lodash")
    expect(groups![1].risk).toBe("medium")
  })

  test("returns null when no XML tags present", () => {
    expect(extractFinalizeGroups("just some text without tags")).toBeNull()
  })

  test("returns null for empty array", () => {
    expect(extractFinalizeGroups("<finalize_groups>[]</finalize_groups>")).toBeNull()
  })

  test("returns null for malformed JSON", () => {
    expect(extractFinalizeGroups("<finalize_groups>{not json]</finalize_groups>")).toBeNull()
  })

  test("returns null when name is missing", () => {
    const text = `<finalize_groups>[{"title": "fix", "files": ["a.ts"]}]</finalize_groups>`
    expect(extractFinalizeGroups(text)).toBeNull()
  })

  test("returns null when files is empty", () => {
    const text = `<finalize_groups>[{"name": "a", "title": "fix", "files": []}]</finalize_groups>`
    expect(extractFinalizeGroups(text)).toBeNull()
  })

  test("normalizes group names to kebab-case", () => {
    const text = `<finalize_groups>[{"name": "My Cool Feature!", "title": "feat", "files": ["a.ts"]}]</finalize_groups>`
    const groups = extractFinalizeGroups(text)
    expect(groups![0].name).toBe("my-cool-feature")
  })

  test("defaults risk to low when invalid", () => {
    const text = `<finalize_groups>[{"name": "a", "title": "fix", "files": ["a.ts"], "risk": "extreme"}]</finalize_groups>`
    const groups = extractFinalizeGroups(text)
    expect(groups![0].risk).toBe("low")
  })

  test("defaults description to empty string when missing", () => {
    const text = `<finalize_groups>[{"name": "a", "title": "fix", "files": ["a.ts"]}]</finalize_groups>`
    const groups = extractFinalizeGroups(text)
    expect(groups![0].description).toBe("")
  })
})

describe("validateGroups", () => {
  test("validates a correct partition", () => {
    const groups = [
      { name: "a", title: "fix a", description: "", files: ["x.ts", "y.ts"], risk: "low" as const },
      { name: "b", title: "fix b", description: "", files: ["z.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts", "y.ts", "z.ts"])
    expect(result.valid).toBe(true)
  })

  test("rejects overlapping files", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["x.ts"], risk: "low" as const },
      { name: "b", title: "fix", description: "", files: ["x.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts"])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toContain("x.ts")
  })

  test("rejects when files are unassigned", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["x.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts", "y.ts"])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toContain("y.ts")
  })

  test("strips phantom files silently", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["x.ts", "phantom.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts"])
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.groups[0].files).toEqual(["x.ts"])
  })

  test("removes groups left empty after phantom stripping", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["x.ts"], risk: "low" as const },
      { name: "b", title: "fix", description: "", files: ["phantom.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts"])
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.groups.length).toBe(1)
  })

  test("rejects all-phantom groups", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["phantom.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts"])
    expect(result.valid).toBe(false)
  })

  test("rejects duplicate group names", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["x.ts"], risk: "low" as const },
      { name: "a", title: "fix", description: "", files: ["y.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts", "y.ts"])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toContain("Duplicate")
  })
})
