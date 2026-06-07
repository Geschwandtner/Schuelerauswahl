const fs = require('node:fs');
const path = require('node:path');

const filePath = path.join(
  __dirname,
  '..',
  'node_modules',
  '@infinitered',
  'react-native-mlkit-text-recognition',
  'ios',
  'RNMLKitTextRecord.swift',
);

if (!fs.existsSync(filePath)) {
  process.exit(0);
}

const source = fs.readFileSync(filePath, 'utf8');
const patched = source.replace(
  'func mapTextToRecord(_ text: Text) -> TextRecord {',
  'func mapTextToRecord(_ text: MLKitTextRecognition.Text) -> TextRecord {',
);

if (patched !== source) {
  fs.writeFileSync(filePath, patched);
  console.log('Patched @infinitered/react-native-mlkit-text-recognition Swift Text type.');
}
