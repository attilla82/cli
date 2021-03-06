import * as path from 'path'
import { createServer } from 'http'
import * as WebSocket from 'ws'
import * as express from 'express'
import { EventEmitter } from 'events'
import * as fs from 'fs-extra'
import * as portfinder from 'portfinder'
import * as bodyParser from 'body-parser'
import * as cors from 'cors'
import * as spinner from '../utils/spinner'

import { fail, ErrorType } from '../utils/errors'
import { Watcher } from './Watcher'

type Decentraland = import('./Decentraland').Decentraland

function nocache(req, res, next) {
  res.setHeader('Surrogate-Control', 'no-store')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  next()
}

/**
 * Events emitted by this class:
 *
 * preview:ready - The server is up and running
 */
export class Preview extends EventEmitter {
  private app = express()
  private server = createServer(this.app)
  private wss = new WebSocket.Server({ server: this.server })

  constructor(public dcl: Decentraland, private ignoredPaths: string, private watch: boolean) {
    super()
  }

  async startServer(port: number) {
    let resolvedPort = port

    if (!resolvedPort) {
      try {
        resolvedPort = await portfinder.getPortPromise()
      } catch (e) {
        resolvedPort = 2044
      }
    }

    const watcher = new Watcher(this.dcl.getWorkingDir(), this.ignoredPaths)

    watcher.onProcessingComplete.push(() => {
      this.wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send('update')

          client.send(
            JSON.stringify({
              type: 'update'
            })
          )
        }
      })
    })

    spinner.create('Hashing files')

    try {
      await watcher.initialMappingsReady
      spinner.succeed('Hashing files')
    } catch (e) {
      spinner.fail('Hashing files')
      throw e
    }

    if (this.watch) {
      watcher.watch()
    }

    this.app.use(cors())

    const npmModulesPath = path.resolve(this.dcl.getWorkingDir(), 'node_modules')

    // TODO: dcl.project.needsDependencies() should do this
    if (!fs.pathExistsSync(npmModulesPath)) {
      fail(ErrorType.PREVIEW_ERROR, `Couldn\'t find ${npmModulesPath}, please run: npm install`)
    }

    const dclEcsPath = path.resolve(this.dcl.getWorkingDir(), 'node_modules', 'decentraland-ecs')
    const dclApiPath = path.resolve(this.dcl.getWorkingDir(), 'node_modules', 'decentraland-api')

    const artifactPath = fs.pathExistsSync(dclEcsPath) ? dclEcsPath : dclApiPath
    const unityPath = path.resolve(dclEcsPath, 'artifacts', 'unity')

    if (!fs.pathExistsSync(artifactPath)) {
      fail(
        ErrorType.PREVIEW_ERROR,
        `Couldn\'t find ${dclApiPath} or ${dclEcsPath}, please run: npm install`
      )
    }

    this.app.get('/', async (req, res) => {
      res.setHeader('Content-Type', 'text/html')

      const ethConnectExists = await fs.pathExists(
        path.resolve(this.dcl.getWorkingDir(), 'node_modules', 'eth-connect')
      )

      const response = await getHTML(artifactPath, !!req.query.UNITY_ENABLED, ethConnectExists)
      res.send(response)
    })

    this.app.use('/@', express.static(artifactPath))
    this.app.use('/unity', express.static(unityPath))

    this.app.use('/contents/', express.static(this.dcl.getWorkingDir()))

    this.app.get('/mappings', (req, res) => {
      res.json(watcher.getMappings())
    })

    this.app.get('/Qm:cid', (req, res) => {
      const file = watcher.resolveCID('Qm' + req.params.cid)

      if (file) {
        res.sendFile(file)
      } else {
        res.sendStatus(404)
      }
    })

    this.app.use(express.static(this.dcl.getWorkingDir()))

    this.app.use(nocache)

    setUpRendezvous(this.app)

    this.emit('preview:ready', resolvedPort)

    return new Promise((resolve, reject) => {
      this.server
        .listen(resolvedPort)
        .on('close', resolve)
        .on('error', reject)
    })
  }
}

// TODO remove this when babylon's out of project
async function getHTML(
  artifactPath: string,
  unityEnabled: boolean,
  ethConnectExists: boolean
): Promise<string> {
  if (unityEnabled) {
    const htmlPath = path.resolve(artifactPath, 'artifacts', 'unity-preview.html')
    const html = await fs.readFile(htmlPath, {
      encoding: 'utf8'
    })
    return html.replace(
      '<script src="/@/artifacts/unity/Build/UnityLoader.js"></script>',
      `<script>window.avoidWeb3=${!ethConnectExists}</script>\n<script src="/@/artifacts/unity/Build/UnityLoader.js"></script>`
    )
  } else {
    const htmlPath = path.resolve(artifactPath, 'artifacts', 'preview.html')
    const html = await fs.readFile(htmlPath, {
      encoding: 'utf8'
    })

    return html.replace(
      '<script src="/@/artifacts/preview.js"></script>',
      `<script>window.avoidWeb3=${!ethConnectExists}</script>\n<script src="/@/artifacts/preview.js"></script>`
    )
  }
}

function setUpRendezvous(app: express.Express) {
  /**
   * Store all connections in place
   */
  const connections = []

  /**
   * This middleware sets up Server-Sent Events.
   */
  const sse = (req, res, next) => {
    const connection = {
      uuid: req.params.uuid,
      res: res
    }

    // SSE protocol works by setting the `content-type` to `event-stream`
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })

    // Enrich the response object with the ability to send packets
    res.sseSend = data => {
      try {
        res.write('data: ' + JSON.stringify(data) + '\n\n')
      } catch (e) {
        connections.splice(connections.indexOf(connection), 1)
        clearInterval(res.interval)
      }
    }

    // Setup an interval to keep the connection alive
    res.interval = setInterval(() => {
      res.sseSend({
        type: 'ping'
      })
    }, 5000)

    // Store the connection
    connections.push(connection)

    next()
  }

  app.use(bodyParser.json())

  app.post('/signaling/announce', (req, res) => {
    const uuid = req.body.uuid

    const packet = {
      type: 'announce',
      uuid: uuid
    }

    connections.forEach(c => {
      // Don't announce to self
      if (c.uuid !== uuid) {
        c.res.sseSend(packet)
      }
    })

    res.sendStatus(200)
  })

  app.post('/signaling/:uuid/signal', (req, res) => {
    const uuid = req.params.uuid

    const packet = {
      type: 'signal',
      initiator: req.body.initiator,
      data: req.body.data,
      uuid: req.body.uuid
    }

    let result = false

    connections.forEach(c => {
      if (c.uuid === uuid) {
        c.res.sseSend(packet)
        result = true
      }
    })

    res.sendStatus(result ? 200 : 404)
  })

  app.get('/signaling/:uuid/listen', sse, (_, res) => {
    // tslint:disable-next-line:semicolon
    ;(res as any).sseSend({
      type: 'accept'
    })
  })
}
