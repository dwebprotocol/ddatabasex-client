# @ddatabase/streams

External implementation of a WriteStream and ReadStream for dDatabase

```
npm install @ddatabase/streams
```

## Usage

``` js
const { WriteStream, ReadStream } = require('@ddatabase/streams')

const ws = new WriteStream(feed)
const rs = new ReadStream(feed, {
  start: 0,
  live: true,
  valueEncoding: 'json'
})
```

## License

MIT
