import fs from 'node:fs';
import path from 'node:path';

const protoPath = path.resolve(
  'node_modules/@liamcottle/rustplus.js/rustplus.proto'
);

if (!fs.existsSync(protoPath)) {
  console.error(`rustplus.proto not found: ${protoPath}`);
  process.exit(1);
}

let proto = fs.readFileSync(protoPath, 'utf8');

const before = (proto.match(/\brequired\b/g) || []).length;

proto = proto.replace(/\brequired\b/g, 'optional');

const after = (proto.match(/\brequired\b/g) || []).length;

fs.writeFileSync(protoPath, proto, 'utf8');

console.log(
  `RustPlus protobuf fixed: converted ${before - after} required fields to optional.`
);