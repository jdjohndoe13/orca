import type * as core from './runtime-environment-hub-link-store'
import type * as rowCore from './runtime-environment-hub-row-operations'
import { submitEnvironmentStoreCommand } from './runtime-environment-store-worker-client'

/**
 * Async hub surface. The link file and the derived rows are read and written on the environment
 * store worker, like the pairing store itself, so a hub's access key never blocks the thread that
 * serves the windows.
 */

export async function readHubLinks(
  ...args: Parameters<typeof core.readHubLinks>
): Promise<ReturnType<typeof core.readHubLinks>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'readHubLinks', args })
  if (reply.operation !== 'readHubLinks') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function addHubLink(
  ...args: Parameters<typeof core.addHubLink>
): Promise<ReturnType<typeof core.addHubLink>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'addHubLink', args })
  if (reply.operation !== 'addHubLink') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function removeHubLink(
  ...args: Parameters<typeof core.removeHubLink>
): Promise<ReturnType<typeof core.removeHubLink>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'removeHubLink', args })
  if (reply.operation !== 'removeHubLink') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function syncHubEnvironments(
  ...args: Parameters<typeof rowCore.syncHubEnvironments>
): Promise<ReturnType<typeof rowCore.syncHubEnvironments>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'syncHubEnvironments', args })
  if (reply.operation !== 'syncHubEnvironments') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function removeHubEnvironmentsForHub(
  ...args: Parameters<typeof rowCore.removeHubEnvironmentsForHub>
): Promise<ReturnType<typeof rowCore.removeHubEnvironmentsForHub>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'removeHubEnvironmentsForHub',
    args
  })
  if (reply.operation !== 'removeHubEnvironmentsForHub') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function pruneHubEnvironmentsForLinks(
  ...args: Parameters<typeof rowCore.pruneHubEnvironmentsForLinks>
): Promise<ReturnType<typeof rowCore.pruneHubEnvironmentsForLinks>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'pruneHubEnvironmentsForLinks',
    args
  })
  if (reply.operation !== 'pruneHubEnvironmentsForLinks') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}
