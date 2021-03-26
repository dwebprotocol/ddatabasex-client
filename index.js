const { EventEmitter } = require('events')
const maybe = require('call-me-maybe')
const codecs = require('codecs')
const ddatabaseCrypto = require('@ddatabase/crypto')
const inspect = require('inspect-custom-symbol')
const { WriteStream, ReadStream } = require('@ddatabase/streams')

const { NanoresourcePromise: Nanoresource } = require('nanoresource-promise/emitter')
const DWRPC = require('@dhub/rpc')
const getSocketName = require('@dhub/rpc/socket')

class Sessions {
  constructor () {
    this._counter = 0
    this._resourceCounter = 0
    this._freeList = []
    this._remoteBases = new Map()
  }

  create (remoteBase) {
    const id = this._freeList.length ? this._freeList.pop() : this._counter++
    this._remoteBases.set(id, remoteBase)
    return id
  }

  createResourceId () {
    return this._resourceCounter++
  }

  delete (id) {
    this._remoteBases.delete(id)
    this._freeList.push(id)
  }

  get (id) {
    return this._remoteBases.get(id)
  }
}

class RemoteBasestore extends EventEmitter {
  constructor (opts = {}) {
    super()
    this._client = opts.client
    this._name = opts.name
    this._sessions = opts.sessions || new Sessions()

    this._client.ddatabase.onRequest(this, {
      onAppend ({ id, length, byteLength }) {
        const remoteBase = this._sessions.get(id)
        if (!remoteBase) throw new Error('Invalid RemoteDDatabase ID.')
        remoteBase._onappend({ length, byteLength })
      },
      onClose ({ id }) {
        const remoteBase = this._sessions.get(id)
        if (!remoteBase) throw new Error('Invalid RemoteDDatabase ID.')
        remoteBase.close(() => {}) // no unhandled rejects
      },
      onPeerOpen ({ id, peer }) {
        const remoteBase = this._sessions.get(id)
        if (!remoteBase) throw new Error('Invalid RemoteDDatabase ID.')
        remoteBase._onpeeropen(peer)
      },
      onPeerRemove ({ id, peer }) {
        const remoteBase = this._sessions.get(id)
        if (!remoteBase) throw new Error('Invalid RemoteDDatabase ID.')
        remoteBase._onpeerremove(peer)
      },
      onExtension ({ id, resourceId, remotePublicKey, data }) {
        const remoteBase = this._sessions.get(id)
        if (!remoteBase) throw new Error('Invalid RemoteDDatabase ID.')
        remoteBase._onextension({ resourceId, remotePublicKey, data })
      }
    })
    this._client.basestore.onRequest(this, {
      onFeed ({ key }) {
        return this._onfeed(key)
      }
    })
  }

  // Events

  _onfeed (key) {
    if (!this.listenerCount('feed')) return
    this.emit('feed', this.get(key, { weak: true, lazy: true }))
  }

  // Public Methods

  replicate () {
    throw new Error('Cannot call replicate on a RemoteBasestore')
  }

  default (opts = {}) {
    return this.get(opts.key, { name: this._name })
  }

  get (key, opts = {}) {
    if (key && typeof key !== 'string' && !Buffer.isBuffer(key)) {
      opts = key
      key = opts.key
    }
    if (typeof key === 'string') key = Buffer.from(key, 'hex')
    return new RemoteDDatabase(this._client, this._sessions, key, opts)
  }

  namespace (name) {
    return new this.constructor({
      client: this._client,
      sessions: this._sessions,
      name
    })
  }

  ready (cb) {
    return process.nextTick(cb, null)
  }

  close (cb) {
    // TODO: This is a noop for now, but in the future it should send a signal to the daemon to close bases.
    // Closing the top-level client will close the bases (so resource management is still handled).
    return process.nextTick(cb, null)
  }
}

class RemoteNetworker extends EventEmitter {
  constructor (opts) {
    super()
    this._client = opts.client
    this.publicKey = null

    this._client.network.onRequest(this, {
      onPeerOpen ({ peer }) {
        return this.emit('peer-open', peer)
      },
      onPeerRemove ({ peer }) {
        return this.emit('peer-remove', peer)
      }
    })
  }

  configure (discoveryKey, opts = {}) {
    return this._client.network.configure({
      configuration: {
        discoveryKey,
        announce: opts.announce,
        lookup: opts.lookup,
        remember: opts.remember
      },
      flush: opts.flush,
      copyFrom: opts.copyFrom,
      overwrite: opts.overwrite
    })
  }

  async getConfiguration (discoveryKey) {
    const rsp = await this._client.network.getConfiguration({
      discoveryKey
    })
    return rsp.configuration
  }

  async getAllConfigurations () {
    const rsp = await this._client.network.getAllConfigurations()
    return rsp.configurations
  }

  listPeers () {
    return this._client.network.listPeers()
  }
}

class RemoteDDatabase extends Nanoresource {
  constructor (client, sessions, key, opts) {
    super()
    this.key = key
    this.discoveryKey = null
    this.length = 0
    this.byteLength = 0
    this.writable = false
    this.peers = []
    this.valueEncoding = null
    if (opts.valueEncoding) {
      if (typeof opts.valueEncoding === 'string') this.valueEncoding = codecs(opts.valueEncoding)
      else this.valueEncoding = opts.valueEncoding
    }

    this.weak = !!opts.weak
    this.lazy = !!opts.lazy

    this._client = client
    this._sessions = sessions
    this._name = opts.name
    this._id = this.lazy ? undefined : this._sessions.create(this)
    this._extensions = new Map()

    if (!this.lazy) this.ready(() => {})
  }

  ready (cb) {
    return maybe(cb, this.open())
  }

  [inspect] (depth, opts) {
    var indent = ''
    if (typeof opts.indentationLvl === 'number') {
      while (indent.length < opts.indentationLvl) indent += ' '
    }
    return 'RemoteDDatabase(\n' +
      indent + '  key: ' + opts.stylize(this.key && this.key.toString('hex'), 'string') + '\n' +
      indent + '  discoveryKey: ' + opts.stylize(this.discoveryKey && this.discoveryKey.toString('hex'), 'string') + '\n' +
      indent + '  opened: ' + opts.stylize(this.opened, 'boolean') + '\n' +
      indent + '  writable: ' + opts.stylize(this.writable, 'boolean') + '\n' +
      indent + '  length: ' + opts.stylize(this.length, 'number') + '\n' +
      indent + '  byteLength: ' + opts.stylize(this.byteLength, 'number') + '\n' +
      indent + '  peers: ' + opts.stylize(this.peers.length, 'number') + '\n' +
      indent + ')'
  }

  // Nanoresource Methods

  async _open () {
    if (this.lazy) this._id = this._sessions.create(this)
    const rsp = await this._client.basestore.open({
      id: this._id,
      name: this._name,
      key: this.key,
      weak: this.weak
    })
    this.key = rsp.key
    this.discoveryKey = ddatabaseCrypto.discoveryKey(this.key)
    this.writable = rsp.writable
    this.length = rsp.length
    this.byteLength = rsp.byteLength
    if (rsp.peers) this.peers = rsp.peers
    this.emit('ready')
  }

  async _close () {
    await this._client.ddatabase.close({ id: this._id })
    this._sessions.delete(this._id)
    this.emit('close')
  }

  // Events

  _onappend (rsp) {
    this.length = rsp.length
    this.byteLength = rsp.byteLength
    this.emit('append')
  }

  _onpeeropen (peer) {
    const remotePeer = new RemoteDDatabasePeer(peer.type, peer.remoteAddress, peer.remotePublicKey)
    this.peers.push(remotePeer)
    this.emit('peer-open', remotePeer)
  }

  _onpeerremove (peer) {
    const idx = this._indexOfPeer(peer.remotePublicKey)
    if (idx === -1) throw new Error('A peer was removed that was not previously added.')
    const remotePeer = this.peers[idx]
    this.peers.splice(idx, 1)
    this.emit('peer-remove', remotePeer)
  }

  _onextension ({ resourceId, remotePublicKey, data }) {
    const idx = this._indexOfPeer(remotePublicKey)
    if (idx === -1) return
    const remotePeer = this.peers[idx]
    const ext = this._extensions.get(resourceId)
    ext.onmessage(data, remotePeer)
  }

  // Private Methods

  _indexOfPeer (remotePublicKey) {
    for (let i = 0; i < this.peers.length; i++) {
      if (remotePublicKey.equals(this.peers[i].remotePublicKey)) return i
    }

    return -1
  }

  async _append (blocks) {
    if (!this.opened) await this.open()
    if (this.closed) throw new Error('Feed is closed')

    if (!Array.isArray(blocks)) blocks = [blocks]
    if (this.valueEncoding) blocks = blocks.map(b => this.valueEncoding.encode(b))
    const rsp = await this._client.ddatabase.append({
      id: this._id,
      blocks
    })
    return rsp.seq
  }

  async _get (seq, opts) {
    if (!this.opened) await this.open()
    if (this.closed) throw new Error('Feed is closed')

    const rsp = await this._client.ddatabase.get({
      ...opts,
      seq,
      id: this._id
    })
    if (opts && opts.valueEncoding) return codecs(opts.valueEncoding).decode(rsp.block)
    if (this.valueEncoding) return this.valueEncoding.decode(rsp.block)
    return rsp.block
  }

  async _update (opts) {
    if (!this.opened) await this.open()
    if (this.closed) throw new Error('Feed is closed')

    if (typeof opts === 'number') opts = { minLength: opts }
    if (typeof opts.minLength !== 'number') opts.minLength = this.length + 1
    return this._client.ddatabase.update({
      ...opts,
      id: this._id
    })
  }

  async _seek (byteOffset, opts) {
    if (!this.opened) await this.open()
    if (this.closed) throw new Error('Feed is closed')

    const rsp = await this._client.ddatabase.seek({
      byteOffset,
      ...opts,
      id: this._id
    })
    return {
      seq: rsp.seq,
      blockOffset: rsp.blockOffset
    }
  }

  async _has (seq) {
    if (!this.opened) await this.open()
    if (this.closed) throw new Error('Feed is closed')

    const rsp = await this._client.ddatabase.has({
      seq,
      id: this._id
    })
    return rsp.has
  }

  async _download (range, resourceId) {
    if (!this.opened) await this.open()
    if (this.closed) throw new Error('Feed is closed')

    return this._client.ddatabase.download({ ...range, id: this._id, resourceId })
  }

  async _undownload (resourceId) {
    if (!this.opened) await this.open()
    if (this.closed) throw new Error('Feed is closed')

    return this._client.ddatabase.undownload({ id: this._id, resourceId })
  }

  async _downloaded (start, end) {
    if (!this.opened) await this.open()
    if (this.closed) throw new Error('Feed is closed')
    const rsp = await this._client.ddatabase.downloaded({ id: this._id, start, end })
    return rsp.bytes
  }

  // Public Methods

  append (blocks, cb) {
    return maybeOptional(cb, this._append(blocks))
  }

  get (seq, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts
      opts = null
    }
    return maybe(cb, this._get(seq, opts))
  }

  update (opts, cb) {
    if (typeof opts === 'function') {
      cb = opts
      opts = null
    }
    return maybeOptional(cb, this._update(opts))
  }

  seek (byteOffset, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts
      opts = null
    }
    const seekProm = this._seek(byteOffset, opts)
    if (!cb) return seekProm
    seekProm
      .then(({ seq, blockOffset }) => process.nextTick(cb, null, seq, blockOffset))
      .catch(err => process.nextTick(cb, err))
  }

  has (seq, cb) {
    return maybe(cb, this._has(seq))
  }

  createReadStream (opts) {
    return new ReadStream(this, opts)
  }

  createWriteStream (opts) {
    return new WriteStream(this, opts)
  }

  download (range, cb) {
    if (typeof range === 'number') range = { start: range, end: range + 1 }
    if (Array.isArray(range)) range = { blocks: range }

    // much easier to run this in the client due to pbuf defaults
    if (range.blocks && typeof range.start !== 'number') {
      let min = -1
      let max = 0

      for (let i = 0; i < range.blocks.length; i++) {
        const blk = range.blocks[i]
        if (min === -1 || blk < min) min = blk
        if (blk >= max) max = blk + 1
      }

      range.start = min === -1 ? 0 : min
      range.end = max
    }
    if (range.end === -1) range.end = 0 // means the same

    const resourceId = this._sessions.createResourceId()

    const prom = this._download(range, resourceId)
    prom.catch(noop) // optional promise due to the dDatabase signature
    prom.resourceId = resourceId

    maybe(cb, prom)
    return prom // always return prom as that one is the "cancel" token
  }

  undownload (dl, cb) {
    if (typeof dl.resourceId !== 'number') throw new Error('Must pass a download return value')
    return maybeOptional(cb, this._undownload(dl.resourceId))
  }

  downloaded (start, end, cb) {
    if (typeof start === 'function') {
      start = null
      end = null
      cb = start
    } else if (typeof end === 'function') {
      end = null
      cb = end
    }
    return maybe(cb, this._downloaded(start, end))
  }

  lock (onlocked) {
    // TODO: refactor so this can be opened without waiting for open
    if (!this.opened) throw new Error('Cannot acquire a lock for an unopened feed')

    const prom = this._client.ddatabase.acquireLock({ id: this._id })

    if (onlocked) {
      const release = (cb, err, val) => { // mutexify interface
        this._client.ddatabase.releaseLockNoReply({ id: this._id })
        if (cb) cb(err, val)
      }

      prom.then(() => process.nextTick(onlocked, release)).catch(noop)
      return
    }

    return prom.then(() => () => this._client.ddatabase.releaseLockNoReply({ id: this._id }))
  }

  // TODO: Unimplemented methods

  registerExtension (name, opts) {
    const ext = new RemoteExtension(this, name, opts)
    this._extensions.set(ext.resourceId, ext)
    return ext
  }

  replicate () {
    throw new Error('Cannot call replicate on a RemoteDDrive')
  }
}

class RemoteDDatabasePeer {
  constructor (type, remoteAddress, remotePublicKey) {
    this.type = type
    this.remoteAddress = remoteAddress
    this.remotePublicKey = remotePublicKey
  }
}

class RemoteExtension {
  constructor (feed, name, opts = {}) {
    this.resourceId = feed._sessions.createResourceId()
    this.feed = feed
    this.name = name
    this.onmessage = opts.onmessage || noop
    this.onerror = opts.onerror || noop
    this.encoding = codecs((opts && opts.encoding) || 'binary')

    const reg = () => {
      this.feed._client.ddatabase.registerExtensionNoReply({
        id: this.feed._id,
        resourceId: this.resourceId,
        name: this.name
      })
    }

    if (this.feed._id !== undefined) {
      reg()
    } else {
      this.feed.ready((err) => {
        if (err) return this.onerror(err)
        reg()
      })
    }
  }

  broadcast (message) {
    const buf = this.encoding.encode(message)
    if (this.feed._id === undefined) return
    this.feed._client.ddatabase.sendExtensionNoReply({
      id: this.feed._id,
      resourceId: this.resourceId,
      remotePublicKey: null,
      data: buf
    })
  }

  send (message, peer) {
    if (this.feed._id === undefined) return
    this.feed._client.ddatabase.sendExtensionNoReply({
      id: this.feed._id,
      resourceId: this.resourceId,
      remotePublicKey: null,
      data: message
    })
  }
}

class RemotePlugins {
  constructor ({ client }) {
    this._client = client
  }

  async _start (data) {
    return (await this._client.plugins.start(data)).value
  }

  start (name, value, cb) {
    if (typeof value === 'function') return this.start(name, null, value)
    return maybe(cb, this._start({ name, value }))
  }

  stop (name, cb) {
    return maybe(cb, this._client.plugins.stop({ name }))
  }

  status (name, cb) {
    return maybe(cb, this._client.plugins.status({ name }))
  }
}

module.exports = class DHubClient extends Nanoresource {
  constructor (opts = {}) {
    super()
    this._sock = getSocketName(opts.host)
    this._client = DWRPC.connect(this._sock)
    this.basestore = new RemoteBasestore({ client: this._client })
    this.network = new RemoteNetworker({ client: this._client })
    this.plugins = new RemotePlugins({ client: this._client })
  }

  _open () {
    return this._client.connected
  }

  _close () {
    return this._client.destroy()
  }

  ready (cb) {
    return maybe(cb, this.open())
  }
}

function noop () {}

function maybeOptional (cb, prom) {
  prom = maybe(cb, prom)
  if (prom) prom.catch(noop)
  return prom
}
