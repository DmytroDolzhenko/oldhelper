const fs = require('fs');
const path = require('path');

const protoPath = path.join(
    __dirname,
    '..',
    'node_modules',
    '@liamcottle',
    'rustplus.js',
    'rustplus.proto'
);

if (!fs.existsSync(protoPath)) {
    console.log('[fix-rustplus-proto] rustplus.proto not found');
    process.exit(0);
}

let content = fs.readFileSync(protoPath, 'utf8');

const requiredPattern = /required\s+float\s+nearPlane\s*=\s*3\s*;/;
const optionalPattern = /optional\s+float\s+nearPlane\s*=\s*3\s*;/;

if (optionalPattern.test(content)) {
    console.log('[fix-rustplus-proto] nearPlane is already optional');
    process.exit(0);
}

if (requiredPattern.test(content)) {
    content = content.replace(
        requiredPattern,
        'optional float nearPlane = 3;'
    );

    fs.writeFileSync(protoPath, content, 'utf8');

    console.log('[fix-rustplus-proto] nearPlane changed to optional');
} else {
    console.log('[fix-rustplus-proto] nearPlane declaration not found');
}