import * as z from 'zod'
import { openEnum } from '../validation/zod-salvage'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

/**
 * Contact state the gateway derives from its own status registry for one
 * downstream environment. Arms are a wire vocabulary, so a host may add arms
 * in later phases; unknown spellings degrade to `unknown` instead of failing
 * the whole list on the client.
 */
export const RuntimeEnvironmentDownstreamStateSchema = openEnum(
  ['connected', 'unreachable', 'unknown'] as const,
  'unknown'
)
export type RuntimeEnvironmentDownstreamState = z.infer<
  typeof RuntimeEnvironmentDownstreamStateSchema
>

/**
 * One environment visible through a gateway host. `gatewayEnvironmentId` is the
 * downstream environment's id in the gateway's own store — the address a guest
 * sends back with `runtimeEnvironment.call`; it is never an id the guest would
 * find in its own store. `gatewayEnvironmentId: null` is the gateway itself.
 */
export const RuntimeEnvironmentDownstreamRowSchema = lazyZodSchema(() =>
  z.object({
    gatewayEnvironmentId: z.string().nullable(),
    name: z.string(),
    upstreamRuntimeId: z.string().nullable(),
    state: RuntimeEnvironmentDownstreamStateSchema,
    capabilities: z.array(z.string()).nullable()
  })
)
export type RuntimeEnvironmentDownstreamRow = z.infer<typeof RuntimeEnvironmentDownstreamRowSchema>

export const RuntimeEnvironmentDownstreamListResultSchema = lazyZodSchema(() =>
  z.object({
    environments: z.array(RuntimeEnvironmentDownstreamRowSchema)
  })
)
export type RuntimeEnvironmentDownstreamListResult = z.infer<
  typeof RuntimeEnvironmentDownstreamListResultSchema
>
