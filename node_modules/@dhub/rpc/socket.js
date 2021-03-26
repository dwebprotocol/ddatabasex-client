const os = require('os')

module.exports = function getSocketPath (name) {
  name = name || 'dhub'
  return os.platform() !== 'win32' ? `/tmp/${name}.sock` : `\\\\.\\pipe\\${name}`
}
