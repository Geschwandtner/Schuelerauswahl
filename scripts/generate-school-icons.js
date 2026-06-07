const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'assets');

const palette = {
  cream: [244, 247, 242, 255],
  paper: [255, 253, 245, 255],
  green: [47, 125, 99, 255],
  dark: [23, 35, 30, 255],
  chalk: [236, 245, 238, 255],
  yellow: [240, 201, 74, 255],
  badgeYellow: [247, 201, 72, 255],
  signalRed: [215, 25, 32, 255],
  badgeHalo: [255, 244, 194, 210],
  blue: [58, 87, 157, 255],
  shadow: [16, 24, 20, 45],
  transparent: [0, 0, 0, 0],
  white: [255, 255, 255, 255],
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function makeCanvas(width, height, color = palette.transparent) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = color[0];
    data[index + 1] = color[1];
    data[index + 2] = color[2];
    data[index + 3] = color[3];
  }
  return { width, height, data };
}

function blendPixel(canvas, x, y, color, alphaFactor = 1) {
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  if (roundedX < 0 || roundedX >= canvas.width || roundedY < 0 || roundedY >= canvas.height) {
    return;
  }

  const offset = (roundedY * canvas.width + roundedX) * 4;
  const sourceAlpha = (color[3] / 255) * alphaFactor;
  const destinationAlpha = canvas.data[offset + 3] / 255;
  const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);

  if (outAlpha <= 0) {
    return;
  }

  for (let channel = 0; channel < 3; channel += 1) {
    const source = color[channel] / 255;
    const destination = canvas.data[offset + channel] / 255;
    canvas.data[offset + channel] = Math.round(((source * sourceAlpha + destination * destinationAlpha * (1 - sourceAlpha)) / outAlpha) * 255);
  }

  canvas.data[offset + 3] = Math.round(outAlpha * 255);
}

function rect(canvas, x, y, width, height, color) {
  const startX = clamp(Math.floor(x), 0, canvas.width);
  const endX = clamp(Math.ceil(x + width), 0, canvas.width);
  const startY = clamp(Math.floor(y), 0, canvas.height);
  const endY = clamp(Math.ceil(y + height), 0, canvas.height);

  for (let py = startY; py < endY; py += 1) {
    for (let px = startX; px < endX; px += 1) {
      blendPixel(canvas, px, py, color);
    }
  }
}

function roundedRect(canvas, x, y, width, height, radius, color) {
  const startX = clamp(Math.floor(x), 0, canvas.width);
  const endX = clamp(Math.ceil(x + width), 0, canvas.width);
  const startY = clamp(Math.floor(y), 0, canvas.height);
  const endY = clamp(Math.ceil(y + height), 0, canvas.height);

  for (let py = startY; py < endY; py += 1) {
    for (let px = startX; px < endX; px += 1) {
      const dx = px < x + radius ? x + radius - px : px > x + width - radius ? px - (x + width - radius) : 0;
      const dy = py < y + radius ? y + radius - py : py > y + height - radius ? py - (y + height - radius) : 0;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= radius) {
        blendPixel(canvas, px, py, color);
      } else if (distance <= radius + 1) {
        blendPixel(canvas, px, py, color, radius + 1 - distance);
      }
    }
  }
}

function circle(canvas, centerX, centerY, radius, color) {
  const startX = clamp(Math.floor(centerX - radius - 1), 0, canvas.width);
  const endX = clamp(Math.ceil(centerX + radius + 1), 0, canvas.width);
  const startY = clamp(Math.floor(centerY - radius - 1), 0, canvas.height);
  const endY = clamp(Math.ceil(centerY + radius + 1), 0, canvas.height);

  for (let py = startY; py < endY; py += 1) {
    for (let px = startX; px < endX; px += 1) {
      const distance = Math.sqrt((px - centerX) ** 2 + (py - centerY) ** 2);
      if (distance <= radius) {
        blendPixel(canvas, px, py, color);
      } else if (distance <= radius + 1) {
        blendPixel(canvas, px, py, color, radius + 1 - distance);
      }
    }
  }
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function polygon(canvas, points, color) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const startX = clamp(Math.floor(Math.min(...xs)), 0, canvas.width);
  const endX = clamp(Math.ceil(Math.max(...xs)), 0, canvas.width);
  const startY = clamp(Math.floor(Math.min(...ys)), 0, canvas.height);
  const endY = clamp(Math.ceil(Math.max(...ys)), 0, canvas.height);

  for (let py = startY; py < endY; py += 1) {
    for (let px = startX; px < endX; px += 1) {
      if (pointInPolygon(px + 0.5, py + 0.5, points)) {
        blendPixel(canvas, px, py, color);
      }
    }
  }
}

function line(canvas, x1, y1, x2, y2, thickness, color) {
  const minX = clamp(Math.floor(Math.min(x1, x2) - thickness), 0, canvas.width);
  const maxX = clamp(Math.ceil(Math.max(x1, x2) + thickness), 0, canvas.width);
  const minY = clamp(Math.floor(Math.min(y1, y2) - thickness), 0, canvas.height);
  const maxY = clamp(Math.ceil(Math.max(y1, y2) + thickness), 0, canvas.height);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;

  for (let py = minY; py < maxY; py += 1) {
    for (let px = minX; px < maxX; px += 1) {
      const t = lengthSq === 0 ? 0 : clamp(((px - x1) * dx + (py - y1) * dy) / lengthSq, 0, 1);
      const projectionX = x1 + t * dx;
      const projectionY = y1 + t * dy;
      const distance = Math.sqrt((px - projectionX) ** 2 + (py - projectionY) ** 2);
      if (distance <= thickness / 2) {
        blendPixel(canvas, px, py, color);
      } else if (distance <= thickness / 2 + 1) {
        blendPixel(canvas, px, py, color, thickness / 2 + 1 - distance);
      }
    }
  }
}

function drawSchoolMark(canvas, options = {}) {
  const scale = canvas.width / 1024;
  const mono = options.mono ?? false;
  const ink = mono ? palette.white : palette.dark;
  const board = mono ? palette.white : palette.dark;
  const boardInner = mono ? [0, 0, 0, 0] : [33, 73, 58, 255];
  const studentFill = mono ? palette.white : palette.chalk;
  const selectedFill = mono ? palette.white : [255, 253, 245, 255];
  const variant = options.variant ?? 'grid';

  const s = (value) => value * scale;

  if (!options.transparent) {
    drawIconBackground(canvas);
  }

  roundedRect(canvas, s(119), s(120), s(786), s(790), s(88), palette.shadow);
  roundedRect(canvas, s(92), s(92), s(840), s(840), s(96), board);
  roundedRect(canvas, s(136), s(136), s(752), s(752), s(50), boardInner);
  line(canvas, s(198), s(824), s(826), s(824), s(24), mono ? palette.white : palette.green);
  line(canvas, s(198), s(184), s(826), s(184), s(14), mono ? palette.white : [47, 125, 99, 210]);

  if (variant.startsWith('desks')) {
    drawDeskClassroom(canvas, s, mono, studentFill, selectedFill, variant);
    return;
  }

  if (variant === 'spotlight') {
    drawSpotlightClassroom(canvas, s, mono, studentFill, selectedFill);
    return;
  }

  drawGridClassroom(canvas, s, mono, studentFill, selectedFill);
}

function drawGridClassroom(canvas, s, mono, studentFill, selectedFill) {
  const students = [
    { x: 288, y: 300, hair: 'cap', body: [236, 245, 238, 255] },
    { x: 512, y: 300, hair: 'short', body: [221, 238, 230, 255] },
    { x: 736, y: 300, hair: 'long', body: [236, 245, 238, 255] },
    { x: 288, y: 520, hair: 'long', body: [221, 238, 230, 255] },
    { x: 512, y: 520, hair: 'short', body: [255, 253, 245, 255], selected: true },
    { x: 736, y: 520, hair: 'cap', body: [221, 238, 230, 255] },
    { x: 288, y: 740, hair: 'short', body: [236, 245, 238, 255] },
    { x: 512, y: 740, hair: 'long', body: [221, 238, 230, 255] },
    { x: 736, y: 740, hair: 'short', body: [236, 245, 238, 255] },
  ];

  students.forEach((student) => {
    drawStudent(canvas, s(student.x), s(student.y), s(0.82), {
      body: mono ? studentFill : student.selected ? selectedFill : student.body,
      hair: student.hair,
      mono,
      selected: student.selected,
    });
  });

  drawSelectionBadge(canvas, s(584), s(560), s(50), mono);
}

function drawDeskClassroom(canvas, s, mono, studentFill, selectedFill, variant) {
  const students = [
    { x: 288, y: 284, hair: 'cap', body: [236, 245, 238, 255] },
    { x: 512, y: 284, hair: 'short', body: [221, 238, 230, 255] },
    { x: 736, y: 284, hair: 'long', body: [236, 245, 238, 255] },
    { x: 288, y: 508, hair: 'long', body: [221, 238, 230, 255] },
    { x: 512, y: 508, hair: 'short', body: [255, 253, 245, 255], selected: true },
    { x: 736, y: 508, hair: 'cap', body: [221, 238, 230, 255] },
    { x: 288, y: 732, hair: 'short', body: [236, 245, 238, 255] },
    { x: 512, y: 732, hair: 'long', body: [221, 238, 230, 255] },
    { x: 736, y: 732, hair: 'short', body: [236, 245, 238, 255] },
  ];

  students.forEach((student) => {
    drawStudent(canvas, s(student.x), s(student.y), s(0.74), {
      body: mono ? studentFill : student.selected ? selectedFill : student.body,
      hair: student.hair,
      mono,
      selected: student.selected,
    });
    drawDesk(canvas, s(student.x), s(student.y + 76), s(0.74), mono, student.selected, variant);
  });

  drawSelectionBadge(canvas, s(590), s(534), s(72), mono);
}

function drawSpotlightClassroom(canvas, s, mono, studentFill, selectedFill) {
  const students = [
    { x: 252, y: 315, hair: 'cap', body: [236, 245, 238, 255] },
    { x: 512, y: 280, hair: 'short', body: [221, 238, 230, 255] },
    { x: 772, y: 315, hair: 'long', body: [236, 245, 238, 255] },
    { x: 252, y: 520, hair: 'long', body: [221, 238, 230, 255] },
    { x: 512, y: 520, hair: 'short', body: [255, 253, 245, 255], selected: true },
    { x: 772, y: 520, hair: 'cap', body: [221, 238, 230, 255] },
    { x: 252, y: 725, hair: 'short', body: [236, 245, 238, 255] },
    { x: 512, y: 760, hair: 'long', body: [221, 238, 230, 255] },
    { x: 772, y: 725, hair: 'short', body: [236, 245, 238, 255] },
  ];

  students.forEach((student) => {
    drawStudent(canvas, s(student.x), s(student.y), s(student.selected ? 0.92 : 0.72), {
      body: mono ? studentFill : student.selected ? selectedFill : student.body,
      hair: student.hair,
      mono,
      selected: student.selected,
    });
  });

  drawSelectionBadge(canvas, s(594), s(548), s(52), mono);
}

function drawIconBackground(canvas) {
  const scale = canvas.width / 1024;
  const s = (value) => value * scale;

  rect(canvas, 0, 0, canvas.width, canvas.height, palette.cream);
  circle(canvas, s(850), s(174), s(120), [231, 239, 230, 255]);
  circle(canvas, s(174), s(820), s(150), [233, 241, 234, 255]);
}

function drawStudent(canvas, x, y, scale, options) {
  const mono = options.mono;
  const hairColor = mono ? palette.white : palette.dark;
  const faceColor = mono ? palette.white : [236, 245, 238, 255];
  const bodyColor = options.body;
  const s = (value) => value * scale;

  if (!mono && options.selected) {
    circle(canvas, x, y + s(18), s(94), [240, 201, 74, 45]);
  }

  if (options.hair === 'long') {
    roundedRect(canvas, x - s(64), y - s(71), s(128), s(128), s(60), hairColor);
    roundedRect(canvas, x - s(54), y - s(36), s(108), s(102), s(48), hairColor);
  } else if (options.hair === 'cap') {
    circle(canvas, x, y - s(30), s(61), hairColor);
    roundedRect(canvas, x - s(56), y - s(78), s(112), s(48), s(24), hairColor);
  } else {
    circle(canvas, x, y - s(29), s(61), hairColor);
    roundedRect(canvas, x - s(54), y - s(82), s(108), s(54), s(27), hairColor);
  }

  circle(canvas, x, y - s(18), s(54), faceColor);
  roundedRect(canvas, x - s(71), y + s(34), s(142), s(110), s(45), bodyColor);
}

function getDeskPalette(variant) {
  if (variant === 'desks-birch') {
    return {
      edge: [123, 78, 38, 255],
      fill: [204, 145, 83, 255],
      highlight: [229, 178, 113, 255],
      selectedFill: [224, 157, 88, 255],
      shadow: [84, 48, 25, 58],
    };
  }

  if (variant === 'desks-walnut') {
    return {
      edge: [83, 50, 30, 255],
      fill: [142, 87, 48, 255],
      highlight: [177, 113, 64, 255],
      selectedFill: [167, 99, 54, 255],
      shadow: [51, 30, 20, 68],
    };
  }

  return {
    edge: [96, 58, 28, 255],
    fill: [175, 111, 56, 255],
    highlight: [213, 151, 84, 255],
    selectedFill: [196, 127, 63, 255],
    shadow: [62, 36, 20, 64],
  };
}

function drawDesk(canvas, x, y, scale, mono, selected, variant) {
  const s = (value) => value * scale;
  const deskPalette = getDeskPalette(variant);
  const fill = mono ? palette.white : selected ? deskPalette.selectedFill : deskPalette.fill;
  const highlight = mono ? palette.white : deskPalette.highlight;
  const shadow = mono ? palette.white : deskPalette.shadow;
  const edge = mono ? palette.white : deskPalette.edge;

  roundedRect(canvas, x - s(90), y - s(8), s(180), s(72), s(18), shadow);
  roundedRect(canvas, x - s(90), y - s(20), s(180), s(72), s(18), fill);
  line(canvas, x - s(68), y - s(2), x + s(68), y - s(2), s(7), highlight);
  line(canvas, x - s(62), y + s(24), x + s(62), y + s(24), s(7), edge);
}

function drawSelectionBadge(canvas, x, y, radius, mono) {
  const ink = mono ? palette.white : palette.dark;
  const accent = mono ? palette.white : palette.badgeYellow;

  if (!mono) {
    circle(canvas, x, y, radius + radius * 0.19, palette.badgeHalo);
    circle(canvas, x, y, radius, palette.signalRed);
    circle(canvas, x, y, radius * 0.83, accent);
  } else {
    circle(canvas, x, y, radius, accent);
  }

  line(canvas, x - radius * 0.42, y - radius * 0.02, x - radius * 0.06, y + radius * 0.34, radius * 0.26, ink);
  line(canvas, x - radius * 0.06, y + radius * 0.34, x + radius * 0.48, y - radius * 0.38, radius * 0.26, ink);
}

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(canvas, colorType = 6) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(canvas.width, 0);
  header.writeUInt32BE(canvas.height, 4);
  header[8] = 8;
  header[9] = colorType;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const bytesPerPixel = colorType === 2 ? 3 : 4;
  const raw = Buffer.alloc((canvas.width * bytesPerPixel + 1) * canvas.height);
  let rawOffset = 0;

  for (let y = 0; y < canvas.height; y += 1) {
    raw[rawOffset] = 0;
    rawOffset += 1;

    for (let x = 0; x < canvas.width; x += 1) {
      const sourceOffset = (y * canvas.width + x) * 4;
      raw[rawOffset] = canvas.data[sourceOffset];
      raw[rawOffset + 1] = canvas.data[sourceOffset + 1];
      raw[rawOffset + 2] = canvas.data[sourceOffset + 2];
      rawOffset += 3;
      if (bytesPerPixel === 4) {
        raw[rawOffset] = canvas.data[sourceOffset + 3];
        rawOffset += 1;
      }
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeIcon(filename, size, options = {}) {
  const canvas = makeCanvas(size, size, options.transparent ? palette.transparent : palette.cream);
  if (options.backgroundOnly) {
    drawIconBackground(canvas);
  } else {
    drawSchoolMark(canvas, options);
  }
  const png = encodePng(canvas, options.rgb ? 2 : 6);
  fs.writeFileSync(path.join(assetsDir, filename), png);

  if (options.iosAppIcon) {
    const iosIconPath = path.join(
      root,
      'ios',
      'Schuelerauswahl',
      'Images.xcassets',
      'AppIcon.appiconset',
      'App-Icon-1024x1024@1x.png',
    );
    fs.writeFileSync(iosIconPath, png);
  }
}

writeIcon('icon.png', 1024, { iosAppIcon: true, rgb: true, variant: 'desks-birch' });
writeIcon('splash-icon.png', 1024, { transparent: true });
writeIcon('android-icon-background.png', 512, { backgroundOnly: true });
writeIcon('android-icon-foreground.png', 512, { transparent: true, variant: 'desks-birch' });
writeIcon('android-icon-monochrome.png', 432, { transparent: true, mono: true, variant: 'desks-birch' });
writeIcon('favicon.png', 48, { rgb: false, variant: 'desks-birch' });
writeIcon('icon-variant-a-grid.png', 1024, { rgb: true, variant: 'grid' });
writeIcon('icon-variant-b-pulte.png', 1024, { rgb: true, variant: 'desks-oak' });
writeIcon('icon-variant-c-fokus.png', 1024, { rgb: true, variant: 'spotlight' });
writeIcon('icon-variant-pulte-eiche.png', 1024, { rgb: true, variant: 'desks-oak' });
writeIcon('icon-variant-pulte-birke.png', 1024, { rgb: true, variant: 'desks-birch' });
writeIcon('icon-variant-pulte-nussbaum.png', 1024, { rgb: true, variant: 'desks-walnut' });

console.log('Generated school-themed app icons.');
