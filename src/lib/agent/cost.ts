import type { AgentCost } from "./types.ts"

export function zeroAgentCost(): AgentCost {
  return {
    total_cost_usd: 0,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    input_tokens: 0,
    output_tokens: 0,
  }
}

export function combineAgentCosts(...costs: Array<AgentCost | undefined>): AgentCost | undefined {
  const present = costs.filter((cost): cost is AgentCost => cost !== undefined)
  if (present.length === 0) return undefined

  return present.reduce<AgentCost>((total, cost) => ({
    total_cost_usd: total.total_cost_usd + cost.total_cost_usd,
    duration_ms: total.duration_ms + cost.duration_ms,
    duration_api_ms: total.duration_api_ms + cost.duration_api_ms,
    num_turns: total.num_turns + cost.num_turns,
    input_tokens: total.input_tokens + cost.input_tokens,
    output_tokens: total.output_tokens + cost.output_tokens,
  }), zeroAgentCost())
}
