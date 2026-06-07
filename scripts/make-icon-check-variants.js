const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const workspace = path.resolve(__dirname, '..');
const sourcePath = path.join(workspace, 'assets', 'icon.png');

const variants = [
  {
    name: 'icon-check-variant-1-signalrot.png',
    radius: 68,
    fill: '#F7C948',
    border: '#E60000',
    borderWidth: 10,
    check: '#13231D',
    checkWidth: 18,
    halo: null,
  },
  {
    name: 'icon-check-variant-2-roter-ring.png',
    radius: 72,
    fill: '#F7C948',
    border: '#D71920',
    borderWidth: 12,
    check: '#13231D',
    checkWidth: 19,
    halo: '#FFF4C2',
  },
  {
    name: 'icon-check-variant-3-doppelrand.png',
    radius: 74,
    fill: '#F7C948',
    border: '#E60000',
    borderWidth: 8,
    innerBorder: '#FFF9D6',
    innerBorderWidth: 5,
    check: '#13231D',
    checkWidth: 18,
    halo: null,
  },
  {
    name: 'icon-check-variant-4-weiss-rot.png',
    radius: 70,
    fill: '#F7C948',
    border: '#FFFFFF',
    borderWidth: 8,
    outerBorder: '#E60000',
    outerBorderWidth: 6,
    check: '#13231D',
    checkWidth: 18,
    halo: null,
  },
  {
    name: 'icon-check-variant-5-klarer-fokus.png',
    radius: 76,
    fill: '#F7C948',
    border: '#E60000',
    borderWidth: 10,
    check: '#0E211A',
    checkWidth: 21,
    halo: '#EAF2EB',
  },
];

function hexToRgb(hex) {
  const normalized = hex.replace('#', '');
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function blendPixel(image, x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height || alpha <= 0) {
    return;
  }

  const index = (image.width * y + x) << 2;
  image.data[index] = Math.round(image.data[index] * (1 - alpha) + color.r * alpha);
  image.data[index + 1] = Math.round(image.data[index + 1] * (1 - alpha) + color.g * alpha);
  image.data[index + 2] = Math.round(image.data[index + 2] * (1 - alpha) + color.b * alpha);
  image.data[index + 3] = 255;
}

function drawDisc(image, centerX, centerY, radius, colorHex, alpha = 1) {
  const color = hexToRgb(colorHex);
  const minX = Math.floor(centerX - radius - 2);
  const maxX = Math.ceil(centerX + radius + 2);
  const minY = Math.floor(centerY - radius - 2);
  const maxY = Math.ceil(centerY + radius + 2);

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
      const coverage = Math.max(0, Math.min(1, radius + 0.75 - distance));
      blendPixel(image, x, y, color, coverage * alpha);
    }
  }
}

function drawRing(image, centerX, centerY, radius, width, colorHex) {
  const color = hexToRgb(colorHex);
  const minX = Math.floor(centerX - radius - 2);
  const maxX = Math.ceil(centerX + radius + 2);
  const minY = Math.floor(centerY - radius - 2);
  const maxY = Math.ceil(centerY + radius + 2);
  const innerRadius = radius - width;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
      const outerCoverage = Math.max(0, Math.min(1, radius + 0.75 - distance));
      const innerCoverage = Math.max(0, Math.min(1, innerRadius + 0.75 - distance));
      blendPixel(image, x, y, color, Math.max(0, outerCoverage - innerCoverage));
    }
  }
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function drawRoundLine(image, ax, ay, bx, by, width, colorHex) {
  const color = hexToRgb(colorHex);
  const radius = width / 2;
  const minX = Math.floor(Math.min(ax, bx) - radius - 2);
  const maxX = Math.ceil(Math.max(ax, bx) + radius + 2);
  const minY = Math.floor(Math.min(ay, by) - radius - 2);
  const maxY = Math.ceil(Math.max(ay, by) + radius + 2);

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = pointToSegmentDistance(x + 0.5, y + 0.5, ax, ay, bx, by);
      const coverage = Math.max(0, Math.min(1, radius + 0.75 - distance));
      blendPixel(image, x, y, color, coverage);
    }
  }
}

function drawCheck(image, centerX, centerY, radius, colorHex, width) {
  const leftX = centerX - radius * 0.42;
  const leftY = centerY - radius * 0.02;
  const midX = centerX - radius * 0.06;
  const midY = centerY + radius * 0.34;
  const rightX = centerX + radius * 0.48;
  const rightY = centerY - radius * 0.38;

  drawRoundLine(image, leftX, leftY, midX, midY, width, colorHex);
  drawRoundLine(image, midX, midY, rightX, rightY, width, colorHex);
}

function makeVariant(source, variant) {
  const image = PNG.sync.read(source);
  const centerX = 590;
  const centerY = 535;

  if (variant.halo) {
    drawDisc(image, centerX, centerY, variant.radius + 14, variant.halo, 0.82);
  }

  if (variant.outerBorder) {
    drawDisc(image, centerX, centerY, variant.radius + variant.outerBorderWidth, variant.outerBorder);
  }

  drawDisc(image, centerX, centerY, variant.radius, variant.fill);

  if (variant.border) {
    drawRing(image, centerX, centerY, variant.radius, variant.borderWidth, variant.border);
  }

  if (variant.innerBorder) {
    drawRing(image, centerX, centerY, variant.radius - variant.borderWidth - 2, variant.innerBorderWidth, variant.innerBorder);
  }

  drawCheck(image, centerX, centerY, variant.radius, variant.check, variant.checkWidth);
  return PNG.sync.write(image);
}

const source = fs.readFileSync(sourcePath);

for (const variant of variants) {
  fs.writeFileSync(path.join(workspace, 'assets', variant.name), makeVariant(source, variant));
}
