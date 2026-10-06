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

const replacements = [
  {
    from: 'required float nearPlane = 3;',
    to: 'optional float nearPlane = 3;'
  },
  {
    from: 'required int32 controlFlags = 5;',
    to: 'optional int32 controlFlags = 5;'
  },
  {
    from: 'required int32 sampleOffset = 2;',
    to: 'optional int32 sampleOffset = 2;'
  }
];

for (const { from, to } of replacements) {
  if (proto.includes(from)) {
    proto = proto.replace(from, to);
  }
}

fs.writeFileSync(protoPath, proto, 'utf8');

console.log(
  'RustPlus protobuf fixed: nearPlane, controlFlags and sampleOffset are optional.'
);