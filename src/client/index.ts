import { io } from 'socket.io-client'
import { EventEmitter } from 'events'
import { SERVER } from '../config'
import {
  EventType,
  requestParameter,
  connectOptions
} from '../types/client'
import { compact, uniqueId } from '../utils/functions'
import bs58 from '../utils/base58'
import BigIntPolyfill from 'bignumber.js'
import { CosmJSOfflineSigner, CosmJSOfflineSignerOnlyAmino } from './cosmos'
import { DeviceUUID } from 'device-uuid'

declare let window: any

class Coin98Client extends EventEmitter {
  protected isConnected: boolean = false
  protected isNative?: boolean = false

  private id?: string | number[]

  public client: any
  public linkModule?: any
  public chain: string
  public callbackURL: string

  constructor () {
    super()

    try {
      this.id = new DeviceUUID().get()
    } catch (e) {
      this.id = window.localStorage.getItem('uuid') || uniqueId()
    }

    this.client = io(SERVER, {
      transports: ['websocket'],
      timeout: 600000,
      closeOnBeforeunload: false,
    })

    this.client.on('sdk_connect', (ev: EventType) => {
      const { id } = ev.data
      this.emit(id, ev.data)
    })

    this.client.on('disconnect', () => {
      this.isConnected = false
      this.emit('disconnect')
    })

    window.client = this.client

    // Polyfill
    if (typeof window !== 'undefined' && !window.BigInt) {
      window.BigInt = BigIntPolyfill
    }

    return this
  }

  public connect = (chain: string, options: connectOptions) => {
    if (!chain) {
      throw new Error('Unsupported Chain ID')
    }

    if (!this.client) {
      throw new Error('Coin98 Connect has not been initialized')
    }

    if (!options.name) {
      throw new Error('Dapps Name required')
    }

    this.chain = chain

    // Reset Connection ID
    this.onGenerateAppId()
    // Validate Input

    return new Promise((resolve, reject) => {
      // Initialize SDK
      this.client.emit(
        'coin98_connect',
        {
          type: 'connection_request',
          message: {
            url: new URL(window.location.href).origin,
            id: this.id
          }
        },
        async (cnnStr: string) => {
          // Verify your connection ID
          const isVerify = await this.verifySession(cnnStr)

          if (!isVerify) {
            return reject(new Error('Session is over'))
          }

          // Make a response for your connection string
          this.id = cnnStr

          if (!this.isConnected) {
            this.saveSession(this.id, chain)
            const result: any = await this.request({
              method: 'connect',
              params: [options]
            })

            const errors = result?.error || result?.errors || !result.result

            if (errors) {
              return reject(new Error(errors.message || 'Connection Rejected'))
            }

            this.isConnected = true

            resolve(result)
          }
        }
      )
    })
  }

  public disconnect = () => {
    this.isConnected = false
    // Cleanup connection
    this.clearSession()
    this.client.close()
  }

  public request = (args: requestParameter) => {
    if (!this.isConnected && args.method !== 'connect') {
      throw new Error('You need to connect before handle any request!')
    }

    const id: string = uniqueId()

    const requestParams = {
      ...args,
      id,
      chain: this.chain
    }

    const isSolana: boolean = requestParams.method.startsWith('sol')
    const isCosmos: boolean = requestParams.method.startsWith('cosmos')

    if (isSolana) {
      requestParams.params = this.transformSolanaParams(
        requestParams.params,
        requestParams.method
      )
    }

    if (isCosmos) {
      requestParams.params = this.transformCosmosParams(
        requestParams.params,
        requestParams.method
      )
    }

    requestParams.redirect = encodeURI(
      this.callbackURL || window?.location?.href
    )

    const encodedURL = `${this.id}&request=${this.santinizeParams(
      requestParams
    )}`

    const _this = this
    return new Promise((resolve) => {
      _this.once(id, (e) => {
        resolve(e)
      })
      this.openURL(encodedURL)
    })
  }

  // Cosmos Methods
  public getOfflineSigner (chainId: string) {
    return new CosmJSOfflineSigner(chainId, this)
  }

  public getOfflineSignerAuto (chainId: string) {
    return new CosmJSOfflineSigner(chainId, this)
  }

  public getOfflineSignerOnlyAmino (chainId: string) {
    return new CosmJSOfflineSignerOnlyAmino(chainId, this)
  }

  private transformSolanaParams = (params: any, method: string) => {
    if (method === 'sol_sign') {
      // Transform single transaction
      params[1] =
        typeof params[0] === 'string' || Array.isArray(params[0])
          ? 'message'
          : 'transaction'
      if (params[0].serializeMessage) {
        params[0] = bs58.encode(params[0].serializeMessage())
      }
    }

    if (method === 'sol_signAllTransactions' && Array.isArray(params[0])) {
      const arrTxs = params[0]

      params[0] = arrTxs.slice().map((txs) => {
        if (typeof txs === 'object' && txs.serializeMessage) {
          return bs58.encode(txs.serializeMessage())
        }
        return txs
      })
      params[0] = JSON.stringify(compact(params[0]))
    }

    if (method === 'sol_signMessage') {
      const bufferMsg =
        typeof params[0] === 'string'
          ? Buffer.from(params[0], 'utf-8')
          : params[0]
      params[0] = bs58.encode(bufferMsg)
    }

    return params
  }

  private transformCosmosParams = (params: any, method: string) => {
    if (method === 'cosmos_signDirect') {
      params[0].signDoc.bodyBytes = bs58.encode(params[0].signDoc.bodyBytes)
      params[0].signDoc.authInfoBytes = bs58.encode(
        params[0].signDoc.authInfoBytes
      )
    }

    return params
  }

  private santinizeParams = (params: object) => {
    return encodeURIComponent(JSON.stringify(params))
  }

  private saveSession (id: string, chain: string) {
    if (
      typeof window !== 'undefined' &&
      typeof sessionStorage !== 'undefined'
    ) {
      window.sessionStorage.setItem(
        'Coin98Connection',
        JSON.stringify({ id, chain })
      )
    }
  }

  private verifySession (uri: string): Promise<boolean> {
    const sParams = new URLSearchParams(uri.split('?')[1])
    const token = sParams.get('connect')

    return new Promise(resolve => {
      this.client.emit('coin98_connect', {
        type: 'verify_sdk',
        message: {
          token
        }
      }, (response: boolean) => {
        resolve(response)
      })
    })
  }

  private clearSession () {
    if (
      typeof window !== 'undefined' &&
      typeof sessionStorage !== 'undefined'
    ) {
      window.sessionStorage.removeItem('Coin98Connection')
    }
  }

  private openURL (url: string) {
    // Santinize url
    url = encodeURIComponent(url)
    url = url.startsWith('coin98://') ? url : `coin98://${url}`
    if (window.location.hash) {
      console.log('send?----')
      // Simulate Href Click
      const aTag = document.createElement('a')
      aTag.setAttribute('id', 'coin98Clickable')
      aTag.setAttribute('href', url)
      document.body.appendChild(aTag)
      requestAnimationFrame(() => {
        aTag.click()
        // Safely Remove After Done
        setTimeout(() => {
          const clickable = document.querySelector('#coin98Clickable')
          // eslint-disable-next-line no-unused-expressions
          clickable?.remove()
        }, 200)
      })
    } else {
      window.location.href = url
    }
  }

  private onGenerateAppId = () => {
    try {
      this.id = new DeviceUUID().get()
    } catch (e) {
      this.id = window.localStorage.getItem('uuid') || uniqueId()
    }
  }
}

export default Coin98Client
