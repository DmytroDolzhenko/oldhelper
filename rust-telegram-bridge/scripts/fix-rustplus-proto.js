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

proto = proto.replace(
  'required float nearPlane = 3;',
  'optional float nearPlane = 3;'
);

proto = proto.replace(
  'required int32 controlFlags = 5;',
  'optional int32 controlFlags = 5;'
);

fs.writeFileSync(protoPath, proto, 'utf8');

console.log('RustPlus protobuf fixed: nearPlane/controlFlags are optional.');