# @dhub/client

Standalone DHub RPC client

```
npm install @dhub/client
```

# Usage

``` js
const DHubClient = require('@dhub/client')

const client = new DHubClient() // connect to the DHub server

const basestore = client.basestore() // make a basestore

const feed = basestore.get(someDDatabaseKey) // make a ddatabase

await feed.get(42) // get some data from the ddatabase
```

# API

#### `const client = new DHubClient([options])`

Make a new DHub RPC client. Options include:

``` js
{
  host: 'dhub', // the ipc name of the running server
                      // defaults to dhub
  port                // a TCP port to connect to
}
```

If `port` is specified, or `host` and `port` are both specified, then the client will attempt to connect over TCP.

If you only provide a `host` option, then it will be considered a Unix socket name.

#### `await DHubClient.serverReady([host])`

Static method to wait for the local IPC server to be up and running.

#### `status = await client.status([callback])`

Get status of the local daemon. Includes stuff like API version etc.

#### `await client.close([callback])`

Fully close the client. Cancels all inflight requests.

#### `await client.ready([callback])`

Wait for the client to have fully connected and loaded initial data.

#### `basestore = client.basestore([namespace])`

Make a new remote basestore. Optionally you can pass a specific namespace
to load a specific basestore. If you do not pass a namespace a random one is generated for you.

#### `client.network`

The remote basestore network instance.

#### `client.replicate(base)`

A one-line replication function for `RemoteDDatabases` (see below for details).

## Remote Basestore

The remote basestore instances has an API that mimicks the normal [basestore](https://github.com/andrewosh/basestore) API.

#### `feed = basestore.get([key])`

Make a new remote ddatabase instance. If you pass a key that specific feed is loaded, if not a new one is made.

#### `feed = basestore.default()`

Get the "default" feed for this basestore, which is derived from the namespace.

#### `feed.name`

The name (namespace) of this basestore.

#### `async feed.close([callback])`

Close the basestore. Closes all feeds made in this basestore.

## Remote Networker

The remote networker instance has an API that mimicks the normal [basestore networker](https://github.com/andrewosh/basestore-networker) API.

#### `await network.ready([callback])`

Make sure all the peer state is loaded locally. `client.ready` calls this for you.
Note you do not have to call this before using any of the apis, this just makes sure network.peers is populated.

#### `networks.peers`

A list of peers we are connected to.

#### `network.on('peer-add', peer)`

Emitted when a peer is added.

#### `network.on('peer-remove', peer)`

Emitted when a peer is removed.

#### `await network.configure(discoveryKey | RemoteDDatabase, options)`

Configure the network for this specific discovery key or RemoteDDatabase.
Options include:

```
{
  lookup: true, // should we find peers?
  announce: true, // should we announce ourself as a peer?
  flush: true // wait for the full swarm flush before returning?
  remember: false // persist this configuration so it stays around after we close our session?
}
```

#### `const ext = network.registerExtension(name, { encoding, onmessage, onerror })`

Register a network protocol extension.

## Remote Feed

The remote feed instances has an API that mimicks the normal [DDatabase](https://github.com/ddatabase-protocol/ddatabase) API.

#### `feed.key`

The feed public key

#### `feed.discoveryKey`

The feed discovery key.

#### `feed.writable`

Boolean indicating if this feed is writable.

#### `await feed.ready([callback])`

Wait for the key, discoveryKey, writability, initial peers to be loaded.

#### `const block = await feed.get(index, [options], [callback])`

Get a block of data from the feed.

Options include:

```
{
  ifAvailable: true,
  wait: false,
  onwait () { ... }
}
```

See the [DDatabase docs](https://github.com/ddatabase-protocol/ddatabase) for more info on these options.

Note if you don't await the promise straight away you can use it to to cancel the operation, later using `feed.cancel`

``` js
const p = feed.get(42)
// ... cancel the get
feed.cancel(p)
await p // Was cancelled
```

#### `feed.cancel(p)`

Cancel a get

#### `await feed.has(index, [callback])`

Check if the feed has a specific block

#### `await feed.download(start, end, [callback])`

Select a range to be downloaded.
Similarly to `feed.get` you can use the promise itself
to cancel a download using `feed.undownload(p)`

#### `feed.undownload(p)`

Stop downloading a range.

#### `await feed.update([options], [callback])`

Fetch an update for the feed.

Options include:

``` js
{
  minLength: ..., // some min length to update to
  ifAvailable: true,
  hash: true
}
```

See the [DDatabase docs](https://github.com/ddatabase-protocol/ddatabase) for more info on these options.

#### `await feed.append(blockOrArrayOfBlocks, [callback])`

Append a block or array of blocks to the ddatabase

#### `feed.peers`

A list of peers this feed is connected to.

#### `feed.on('peer-add', peer)`

Emitted when a peer is added.

#### `feed.on('peer-remove', peer)`

Emitted when a peer is removed.

#### `feed.on('append')`

Emitted when the feed is appended to, either locally or remotely.

#### `feed.on('download', seq, data)`

Emitted when a block is downloaded. `data` is a pseudo-buffer with `{length, byteLength}` but no buffer content.

#### `feed.on('upload', seq, data)`

Emitted when a block is uploaded. `data` is a pseudo-buffer with `{length, byteLength}` but no buffer content.

## Replicator

DHub also includes a simple replication function for `RemoteDDatabases` that does two things:
1. It first configures the network (`client.network.configure(base, { announce: true, lookup: true })`)
2. Then it does a `base.update({ ifAvailable: true })` to try to fetch the latest length from the network.

This saves a bit of time when swarming a `RemoteDDatabase`.

#### `await replicate(base)`

Quickly connect a `RemoteDDatabase` to the DSwarm network.

# License

MIT
