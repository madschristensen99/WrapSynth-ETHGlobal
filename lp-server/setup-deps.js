const fs = require('fs');
const path = require('path');

const target = '/home/remsee/node_modules';
const link = path.join(__dirname, 'node_modules');

if (!fs.existsSync(link)) {
  fs.symlinkSync(target, link, 'junction');
  console.log('Created node_modules symlink');
} else {
  console.log('node_modules already exists');
}
