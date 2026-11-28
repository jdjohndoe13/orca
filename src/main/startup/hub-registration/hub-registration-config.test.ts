import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HUB_REGISTRATION_CONFIG_FILENAME,
  resolveHubRegistrationConfig,
  serveWsPortFromEndpoint
} from './hub-registration-config'

const FULL_ENV = {
  ORCA_HUB_URL: 'wss://hub.example:6770/v1/register',
  ORCA_HUB_REGISTRATION_SECRET: 'reg-tenant',
  ORCA_HUB_ACCESS_KEY: 'ak-instance'
}

const directories: string[] = []

async function userData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-hub-config-'))
  directories.push(dir)
  return dir
}

async function writeConfig(dir: string, value: unknown): Promise<void> {
  await writeFile(join(dir, HUB_REGISTRATION_CONFIG_FILENAME), JSON.stringify(value), 'utf8')
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolveHubRegistrationConfig', () => {
  it('stays disabled with no url from either source', async () => {
    const result = await resolveHubRegistrationConfig({
      userDataPath: await userData(),
      env: {},
      servePort: 6768
    })
    expect(result).toEqual({ enabled: false, reason: 'hub_url_missing' })
  })

  it('requires a url, a registration secret and an access key together', async () => {
    const dir = await userData()
    expect(
      await resolveHubRegistrationConfig({
        userDataPath: dir,
        env: { ORCA_HUB_URL: FULL_ENV.ORCA_HUB_URL },
        servePort: 6768
      })
    ).toEqual({ enabled: false, reason: 'registration_secret_missing' })
    expect(
      await resolveHubRegistrationConfig({
        userDataPath: dir,
        env: {
          ORCA_HUB_URL: FULL_ENV.ORCA_HUB_URL,
          ORCA_HUB_REGISTRATION_SECRET: FULL_ENV.ORCA_HUB_REGISTRATION_SECRET
        },
        servePort: 6768
      })
    ).toEqual({ enabled: false, reason: 'access_key_missing' })
  })

  it('refuses a non-websocket url rather than dialing it', async () => {
    const result = await resolveHubRegistrationConfig({
      userDataPath: await userData(),
      env: { ...FULL_ENV, ORCA_HUB_URL: 'https://hub.example/v1/register' },
      servePort: 6768
    })
    expect(result).toEqual({ enabled: false, reason: 'hub_url_invalid' })
  })

  it('reads the whole config from the file beside the keypair', async () => {
    const dir = await userData()
    await writeConfig(dir, {
      url: 'wss://file.example:6770/v1/register',
      registrationSecret: 'reg-file',
      accessKey: 'ak-file',
      name: 'vm-file',
      ports: [6770, 6771],
      capabilities: ['rpc', 'browser'],
      refreshMs: 15_000
    })
    const result = await resolveHubRegistrationConfig({
      userDataPath: dir,
      env: {},
      servePort: 6768,
      hostName: 'ignored'
    })
    expect(result).toEqual({
      enabled: true,
      source: 'file',
      config: {
        url: 'wss://file.example:6770/v1/register',
        registrationSecret: 'reg-file',
        accessKey: 'ak-file',
        name: 'vm-file',
        ports: [6770, 6771],
        capabilities: ['rpc', 'browser'],
        refreshMs: 15_000
      }
    })
  })

  it('lets env win over the file field by field', async () => {
    const dir = await userData()
    await writeConfig(dir, {
      url: 'wss://file.example:6770/v1/register',
      registrationSecret: 'reg-file',
      accessKey: 'ak-file',
      name: 'vm-file'
    })
    const result = await resolveHubRegistrationConfig({
      userDataPath: dir,
      env: {
        ...FULL_ENV,
        // Only the url is overridden, so the file's secrets still count.
        ORCA_HUB_URL: 'wss://env.example:6770/v1/register'
      },
      servePort: 6768
    })
    expect(result.enabled).toBe(true)
    if (!result.enabled) {
      return
    }
    expect(result.source).toBe('env')
    expect(result.config.url).toBe('wss://env.example:6770/v1/register')
    expect(result.config.registrationSecret).toBe('reg-tenant')
    expect(result.config.name).toBe('vm-file')
  })

  it('falls back to the hostname and the serve port when the file is sparse', async () => {
    const dir = await userData()
    await writeConfig(dir, {
      url: 'ws://127.0.0.1:6770/v1/register',
      registrationSecret: 'reg-file',
      accessKey: 'ak-file'
    })
    const result = await resolveHubRegistrationConfig({
      userDataPath: dir,
      env: {},
      servePort: 6769,
      hostName: 'vm-42'
    })
    expect(result.enabled).toBe(true)
    if (!result.enabled) {
      return
    }
    expect(result.config.name).toBe('vm-42')
    expect(result.config.ports).toEqual([6769])
    expect(result.config.capabilities).toEqual(['rpc'])
    expect(result.config.refreshMs).toBe(30_000)
  })

  it('ignores an unreadable or malformed file rather than throwing', async () => {
    const dir = await userData()
    await writeFile(join(dir, HUB_REGISTRATION_CONFIG_FILENAME), '{ not json', 'utf8')
    expect(
      await resolveHubRegistrationConfig({ userDataPath: dir, env: {}, servePort: 6768 })
    ).toEqual({ enabled: false, reason: 'hub_url_missing' })
  })

  it('ignores a file whose ports list is not a port list', async () => {
    const dir = await userData()
    await writeConfig(dir, {
      url: 'wss://hub.example:6770/v1/register',
      registrationSecret: 'reg-tenant',
      accessKey: 'ak-instance',
      ports: [0, 70_000]
    })
    const result = await resolveHubRegistrationConfig({
      userDataPath: dir,
      env: {},
      servePort: 6768,
      hostName: 'vm'
    })
    expect(result.enabled).toBe(true)
    if (!result.enabled) {
      return
    }
    expect(result.config.ports).toEqual([6768])
  })
})

describe('serveWsPortFromEndpoint', () => {
  it('reads the bound port, including the IPv6 bracketed form', () => {
    expect(serveWsPortFromEndpoint('ws://127.0.0.1:6768')).toBe(6768)
    expect(serveWsPortFromEndpoint('ws://[::1]:6769')).toBe(6769)
    expect(serveWsPortFromEndpoint(null)).toBeNull()
    expect(serveWsPortFromEndpoint('not a url')).toBeNull()
  })
})
