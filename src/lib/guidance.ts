import { join } from "node:path"
import { rename, unlink } from "node:fs/promises"

const GUIDANCE_FILE = "guidance.md"
const MAX_GUIDANCE_LENGTH = 2000

export async function readGuidance(runDir: string, maxChars = MAX_GUIDANCE_LENGTH): Promise<string> {
  try {
    const raw = await Bun.file(join(runDir, GUIDANCE_FILE)).text()
    const trimmed = raw.trim()
    if (!trimmed) return ""
    if (trimmed.length > maxChars) return trimmed.slice(0, maxChars) + "\n[truncated]"
    return trimmed
  } catch {
    return ""
  }
}

export async function writeGuidance(runDir: string, text: string): Promise<void> {
  const trimmed = text.trim()
  const guidancePath = join(runDir, GUIDANCE_FILE)
  if (!trimmed) {
    try {
      await unlink(guidancePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return
  }
  const tmpPath = `${guidancePath}.${process.pid}.${Date.now()}.tmp`
  await Bun.write(tmpPath, trimmed + "\n")
  await rename(tmpPath, guidancePath)
}
