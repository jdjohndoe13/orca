import * as z from 'zod'
import { RuntimeRpcEnvelopeSchema } from '../remote-runtime/rpc/runtime-rpc-envelope'
import { requiredString } from './rpc-param-primitives'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

// Split out of runtime-environment-relay-params.ts to keep both files under the
// max-lines budget; the method-name constants and refusal copy stay there.

const RuntimeEnvironmentRelayMethodSchema = requiredString('Missing upstream method')

export const RuntimeEnvironmentGatewayCallParamsSchema = lazyZodSchema(() =>
  z.looseObject({
    gatewayEnvironmentId: requiredString('Missing gateway environment ID'),
    method: RuntimeEnvironmentRelayMethodSchema,
    params: z.unknown().optional()
  })
)
export type RuntimeEnvironmentGatewayCallParams = z.infer<
  typeof RuntimeEnvironmentGatewayCallParamsSchema
>

/**
 * `response` carries the upstream host's RPC envelope VERBATIM — including its
 * failure envelopes, so a caller must read `response.ok` before treating the
 * outer relay result as success. `_meta.gatewayEnvironmentId` is the addressing
 * key the gateway resolved, letting a caller match a reply to the row it named.
 */
export const RuntimeEnvironmentGatewayCallResultSchema = lazyZodSchema(() =>
  z.looseObject({
    response: RuntimeRpcEnvelopeSchema,
    _meta: z.looseObject({ gatewayEnvironmentId: z.string().min(1) })
  })
)
export type RuntimeEnvironmentGatewayCallResult = z.infer<
  typeof RuntimeEnvironmentGatewayCallResultSchema
>

export const RuntimeEnvironmentGatewaySubscribeParamsSchema = lazyZodSchema(() =>
  z.looseObject({
    gatewayEnvironmentId: requiredString('Missing gateway environment ID'),
    method: RuntimeEnvironmentRelayMethodSchema,
    params: z.unknown().optional()
  })
)
export type RuntimeEnvironmentGatewaySubscribeParams = z.infer<
  typeof RuntimeEnvironmentGatewaySubscribeParamsSchema
>

export const RuntimeEnvironmentGatewayUnsubscribeParamsSchema = lazyZodSchema(() =>
  z.looseObject({
    requestId: requiredString('Missing bridge request ID')
  })
)
export type RuntimeEnvironmentGatewayUnsubscribeParams = z.infer<
  typeof RuntimeEnvironmentGatewayUnsubscribeParamsSchema
>

/**
 * One `emit` value per forwarded upstream event, streamed by
 * `runtimeEnvironment.downstream.subscribe`. `response` rides the upstream
 * envelope VERBATIM (success or failure, its `_meta` names the upstream host —
 * never this gateway); binary PTY frames travel as raw binary frames instead,
 * byte-identical, never wrapped in this payload. `end` is the stream-finished
 * marker; `error` carries transport failures so the subscriber can retry.
 */
export const RuntimeEnvironmentGatewaySubscribeEventSchema = lazyZodSchema(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('response'), response: RuntimeRpcEnvelopeSchema }),
    z.object({ type: z.literal('end') }),
    z.object({ type: z.literal('error'), code: z.string(), message: z.string() })
  ])
)
export type RuntimeEnvironmentGatewaySubscribeEvent = z.infer<
  typeof RuntimeEnvironmentGatewaySubscribeEventSchema
>
