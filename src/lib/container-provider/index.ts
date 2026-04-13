/**
 * Container provider registry and re-exports.
 */

export type {
  ContainerProvider,
  ContainerHandle,
  ExecOptions,
  ExecResult,
  StreamingProcess,
} from "./types.ts"

export { MockContainerProvider } from "./mock.ts"

import type { ContainerProvider } from "./types.ts"

export type ContainerProviderFactory = (config: Record<string, unknown>) => Promise<ContainerProvider>

export const MODAL_PROVIDER_ID = "modal"
export const DOCKER_PROVIDER_ID = "docker"

const registry = new Map<string, ContainerProviderFactory>()

export function registerContainerProvider(name: string, factory: ContainerProviderFactory): void {
  registry.set(name, factory)
}

export function getContainerProviderFactory(name: string): ContainerProviderFactory | undefined {
  return registry.get(name)
}

export function listContainerProviders(): string[] {
  return [...registry.keys()]
}

/** Register all built-in container providers (lazy-loaded). */
export function registerDefaultContainerProviders(): void {
  registerContainerProvider(MODAL_PROVIDER_ID, async (config) => {
    const { createModalProvider } = await import("./modal.ts")
    return createModalProvider(config)
  })
  registerContainerProvider(DOCKER_PROVIDER_ID, async (config) => {
    const { createDockerProvider } = await import("./docker.ts")
    return createDockerProvider(config)
  })
}
