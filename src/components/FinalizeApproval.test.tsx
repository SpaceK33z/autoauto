import { afterEach, describe, expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FinalizeApproval, stripFinalizeGroupsBlock } from "./FinalizeApproval.tsx"

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup?.renderer.destroy()
    })
    testSetup = null
  }
})

function findTextarea(renderable: Renderable): TextareaRenderable | null {
  if (renderable instanceof TextareaRenderable) return renderable
  for (const child of renderable.getChildren()) {
    const textarea = findTextarea(child)
    if (textarea) return textarea
  }
  return null
}

describe("FinalizeApproval", () => {
  test("stripFinalizeGroupsBlock removes machine-only XML", () => {
    expect(stripFinalizeGroupsBlock(`## Summary

Looks good.

<finalize_groups>
[{"name":"core"}]
</finalize_groups>`)).toBe("## Summary\n\nLooks good.")
  })

  test("hides finalize_groups XML and starts on action selection", async () => {
    testSetup = await testRender(
      <FinalizeApproval
        summary={`## Summary

Looks good.

<finalize_groups>
[{"name":"core","title":"feat: core change","description":"desc","files":["src/core.ts"],"risk":"low"}]
</finalize_groups>`}
        proposedGroups={[{
          name: "core",
          title: "feat: core change",
          description: "desc",
          files: ["src/core.ts"],
          risk: "low",
        }]}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 100, height: 30, useKittyKeyboard: {} },
    )

    await act(async () => {
      await testSetup?.renderOnce()
    })

    const frame = testSetup.captureCharFrame()
    const textarea = findTextarea(testSetup.renderer.root)

    expect(frame).not.toContain("<finalize_groups>")
    expect(frame).toContain("Approve")
    expect(frame).toContain("Summary")
    expect(textarea?.focused).toBe(false)
  })

  test("shows validation-first copy when extracted groups are invalid", async () => {
    testSetup = await testRender(
      <FinalizeApproval
        summary="## Summary\n\nNeeds revision."
        proposedGroups={null}
        validationError="Files not assigned to any group: src/core.ts"
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 100, height: 24, useKittyKeyboard: {} },
    )

    await act(async () => {
      await testSetup?.renderOnce()
    })

    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Proposed grouping needs revision:")
    expect(frame).toContain("src/core.ts")
    expect(frame).not.toContain("No file groups proposed.")
  })
})
