import chalk from 'chalk'
import { spawn } from 'child_process'
import pick from 'lodash.pick'
import npmRunPath from 'npm-run-path'

import { Checker } from './Checker.js'
import {
  composePreambleCode,
  RUNTIME_CLIENT_ENTRY_PATH,
  RUNTIME_CLIENT_RUNTIME_PATH,
  runtimeCode,
  WS_CHECKER_RECONNECT_EVENT,
} from './client/index.js'
import {
  ACTION_TYPES,
  BuildCheckBinStr,
  BuildInCheckerNames,
  ClientDiagnosticPayload,
  ClientReconnectPayload,
  OverlayErrorAction,
  PluginConfig,
  ServeAndBuildChecker,
  SharedConfig,
  UserPluginConfig,
} from './types.js'

import type { ConfigEnv, Plugin, ResolvedConfig } from 'vite'
const sharedConfigKeys: (keyof SharedConfig)[] = ['enableBuild', 'overlay']
const buildInCheckerKeys: BuildInCheckerNames[] = [
  'typescript',
  'vueTsc',
  'vls',
  'eslint',
  'stylelint',
]

async function createCheckers(
  userConfig: UserPluginConfig,
  env: ConfigEnv
): Promise<ServeAndBuildChecker[]> {
  const serveAndBuildCheckers: ServeAndBuildChecker[] = []
  const sharedConfig = pick(userConfig, sharedConfigKeys)

  // buildInCheckerKeys.forEach(async (name: BuildInCheckerNames) => {
  for (const name of buildInCheckerKeys) {
    if (!userConfig[name]) continue
    const { createServeAndBuild } = await import(`./checkers/${name}/main.js`)
    serveAndBuildCheckers.push(
      createServeAndBuild({ [name]: userConfig[name], ...sharedConfig }, env)
    )
  }

  return serveAndBuildCheckers
}

export function checker(userConfig: UserPluginConfig): Plugin {
  const enableBuild = userConfig?.enableBuild ?? true
  const enableOverlay = userConfig?.overlay !== false
  const enableTerminal = userConfig?.terminal !== false
  const overlayConfig = typeof userConfig?.overlay === 'object' ? userConfig?.overlay : {}
  let initialized = false
  let initializeCounter = 0
  let checkers: ServeAndBuildChecker[] = []
  let isProduction = true
  let skipRuntime = false
  let devBase = '/'

  let viteMode: ConfigEnv['command'] | undefined
  let resolvedConfig: ResolvedConfig | undefined

  return {
    name: 'vite-plugin-checker',
    enforce: 'pre',
    // @ts-ignore
    __internal__checker: Checker,
    config: async (config, env) => {
      // for dev mode (1/2)
      // Initialize checker with config
      viteMode = env.command
      // avoid running twice when running in SSR
      if (initializeCounter === 0) {
        initializeCounter++
      } else {
        initialized = true
        return
      }

      checkers = await createCheckers(userConfig || {}, env)
      if (viteMode !== 'serve') return

      checkers.forEach((checker) => {
        const workerConfig = checker.serve.config
        workerConfig({
          enableOverlay,
          enableTerminal,
          env,
        })
      })
    },
    configResolved(config) {
      resolvedConfig = config
      devBase = config.base
      isProduction = config.isProduction
      skipRuntime ||= isProduction || config.command === 'build'
    },
    buildEnd() {
      if (initialized) return

      if (viteMode === 'serve') {
        checkers.forEach((checker) => {
          const { worker } = checker.serve
          worker.terminate()
        })
      }
    },
    resolveId(id) {
      if (id === RUNTIME_CLIENT_RUNTIME_PATH || id === RUNTIME_CLIENT_ENTRY_PATH) {
        return id
      }

      return
    },
    load(id) {
      if (id === RUNTIME_CLIENT_RUNTIME_PATH) {
        return runtimeCode
      }

      if (id === RUNTIME_CLIENT_ENTRY_PATH) {
        return composePreambleCode(devBase, overlayConfig)
      }

      return
    },
    transformIndexHtml() {
      if (initialized) return
      if (skipRuntime) return

      return [
        {
          tag: 'script',
          attrs: { type: 'module' },
          children: composePreambleCode(resolvedConfig!.base, overlayConfig),
        },
      ]
    },
    buildStart: () => {
      if (initialized) return
      // only run in build mode
      // run a bin command in a separated process
      if (!skipRuntime || !enableBuild) return

      const localEnv = npmRunPath.env({
        env: process.env,
        cwd: process.cwd(),
        execPath: process.execPath,
      })

      // spawn an async runner that we don't wait for in order to avoid blocking the build from continuing in parallel
      ;(async () => {
        const exitCodes = await Promise.all(
          checkers.map((checker) => spawnChecker(checker, userConfig, localEnv))
        )
        const exitCode = exitCodes.find((code) => code !== 0) ?? 0
        // do not exit the process if run `vite build --watch`
        if (exitCode !== 0 && !resolvedConfig?.build.watch) {
          process.exit(exitCode)
        }
      })()
    },
    configureServer(server) {
      if (initialized) return

      let latestOverlayErrors: ClientReconnectPayload['data'] = new Array(checkers.length)
      // for dev mode (2/2)
      // Get the server instance and keep reference in a closure
      checkers.forEach((checker, index) => {
        const { worker, configureServer: workerConfigureServer } = checker.serve
        workerConfigureServer({ root: server.config.root })
        worker.on('message', (action: OverlayErrorAction) => {
          if (action.type === ACTION_TYPES.overlayError) {
            latestOverlayErrors[index] = action.payload as ClientDiagnosticPayload
            if (action.payload) {
              server.ws.send('vite-plugin-checker', action.payload)
            }
          } else if (action.type === ACTION_TYPES.console) {
            Checker.log(action)
          }
        })
      })

      return () => {
        if (server.ws.on) {
          server.ws.on('vite-plugin-checker', (data) => {
            // NOTE: sync modification with packages /packages/runtime/src/ws.js
            if (data.event === 'runtime-loaded') {
              server.ws.send('vite-plugin-checker', {
                event: WS_CHECKER_RECONNECT_EVENT,
                data: latestOverlayErrors.filter(Boolean),
              })
            }
          })
        } else {
          setTimeout(() => {
            console.warn(
              chalk.yellow(
                "[vite-plugin-checker]: `server.ws.on` is introduced to Vite in 2.6.8, see [PR](https://github.com/vitejs/vite/pull/5273) and [changelog](https://github.com/vitejs/vite/blob/main/packages/vite/CHANGELOG.md#268-2021-10-18). \nvite-plugin-checker relies on `server.ws.on` to bring diagnostics back after a full reload and it' not available for you now due to the old version of Vite. You can upgrade Vite to latest version to eliminate this warning."
              )
            )
            // make a delay to avoid flush by Vite's console
          }, 5000)
        }

        server.middlewares.use((req, res, next) => {
          next()
        })
      }
    },
  }
}

function spawnChecker(
  checker: ServeAndBuildChecker,
  userConfig: Partial<PluginConfig>,
  localEnv: npmRunPath.ProcessEnv
) {
  return new Promise<number>((resolve) => {
    const buildBin = checker.build.buildBin
    const finalBin: BuildCheckBinStr =
      typeof buildBin === 'function' ? buildBin(userConfig) : buildBin

    const proc = spawn(...finalBin, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: localEnv,
      // shell is necessary on windows to get the process to even start.
      // Command line args constructed by checkers therefore need to escape double quotes
      // to have them not striped out by cmd.exe. Using shell on all platforms lets us avoid
      // having to perform platform-specific logic around escaping quotes since all platform
      // shells will strip out unescaped double quotes. E.g. shell=false on linux only would
      // result in escaped quotes not being unescaped.
      shell: true,
    })

    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        resolve(code)
      } else {
        resolve(0)
      }
    })
  })
}

export default checker
