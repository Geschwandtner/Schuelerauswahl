import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  Image,
  ImageStyle,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  StyleProp,
  Switch,
  Text,
  TextStyle,
  TextInput,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';

type Student = {
  id: string;
  name: string;
  count: number;
  present: boolean;
  imageUri?: string;
  imageBrightness?: number;
};

type StoredClass = {
  students: Student[];
  selectedId: string | null;
};

type Course = {
  id: string;
  name: string;
  students: Student[];
  selectedId: string | null;
};

type StoredData = {
  activeCourseId: string | null;
  courses: Course[];
  selectionRevealDelayMs: number;
};

type ParsedImportedStudent = {
  name: string;
  count?: number;
  present?: boolean;
};

type OcrRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type OcrLine = {
  text: string;
  frame: OcrRect;
};

type OcrResult = {
  text: string;
  blocks: Array<{
    text: string;
    frame: OcrRect;
    lines: OcrLine[];
  }>;
};

type PhotoCrop = {
  originX: number;
  originY: number;
  width: number;
  height: number;
};

type EdupageImportStudentDraft = {
  id: string;
  name: string;
  imageUri?: string;
  selected: boolean;
  warnings: string[];
};

type EdupageImportDraft = {
  id: string;
  courseName: string;
  sourceImageCount: number;
  students: EdupageImportStudentDraft[];
  warnings: string[];
};

type ImageEditorState = {
  brightness: number;
  offsetX: number;
  offsetY: number;
  sourceHeight: number;
  sourceUri: string;
  sourceWidth: number;
  studentId: string;
  studentName: string;
  zoom: number;
};

type SelectionPhase = 'idle' | 'rolling' | 'confirming';

type StudentSortMode = 'name' | 'chance';

type ChanceLevel = 'high' | 'medium' | 'low';

type SelectionStudentSnapshot = Pick<Student, 'id' | 'name' | 'count' | 'present'>;

type RollingCandidate = {
  id: string;
  name: string;
  remainingBefore: number;
};

type SkippedCandidate = RollingCandidate & {
  key: string;
};

type SelectionRun = {
  absentIds: Set<string>;
  draws: number;
  remainingCounts: Record<string, number>;
  students: SelectionStudentSnapshot[];
  token: number;
};

const STORAGE_KEY = 'oral-exam-picker:v1';
const SECURE_STORAGE_KEY = 'oral-exam-picker.v1';
const DRAW_DELAY_MS = 1300;
const INITIAL_SHUFFLE_DELAY_MS = 1100;
const DEFAULT_SELECTION_REVEAL_DELAY_MS = 2200;
const MIN_SELECTION_REVEAL_DELAY_MS = 1000;
const MAX_SELECTION_REVEAL_DELAY_MS = 5000;
const SELECTION_REVEAL_DELAY_STEP_MS = 250;
const ABSENT_RESTART_DELAY_MS = 1000;
const FIREWORK_COLORS = ['#F0C94A', '#FF5B5B', '#7AD7F0', '#FFFFFF', '#8FE3B3'];
const FIREWORK_LOOP_DURATION_MS = 3800;
const FIREWORK_BURST_MIN_COUNT = 4;
const FIREWORK_BURST_MAX_COUNT = 7;
type PercentPosition = `${number}%`;
const FIREWORK_PARTICLE_DIRECTIONS = [
  [0, -1],
  [0.72, -0.72],
  [1, 0],
  [0.72, 0.72],
  [0, 1],
  [-0.72, 0.72],
  [-1, 0],
  [-0.72, -0.72],
] as const;
type FireworkBurst = {
  color: string;
  delay: number;
  distanceScale: number;
  explosionDuration: number;
  id: string;
  launchDrift: number;
  launchDuration: number;
  particleColors: string[];
  size: number;
  x: PercentPosition;
  y: PercentPosition;
};

function sanitizeSelectionRevealDelay(value: unknown) {
  const parsedValue = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_SELECTION_REVEAL_DELAY_MS;
  }

  const steppedValue = Math.round(parsedValue / SELECTION_REVEAL_DELAY_STEP_MS) * SELECTION_REVEAL_DELAY_STEP_MS;
  return clamp(steppedValue, MIN_SELECTION_REVEAL_DELAY_MS, MAX_SELECTION_REVEAL_DELAY_MS);
}

function getRollingDetailDelay(totalPreviousSelections: number, selectionRevealDelayMs: number) {
  const preferredDelay = sanitizeSelectionRevealDelay(selectionRevealDelayMs);
  return clamp(
    preferredDelay - totalPreviousSelections * 28,
    MIN_SELECTION_REVEAL_DELAY_MS,
    preferredDelay,
  );
}
const STUDENT_IMAGE_DIRECTORY = 'edupage-student-images/';

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED,
};

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function createStudent(name: string, count = 0): Student {
  return {
    id: createId(),
    name: name.trim(),
    count,
    present: true,
  };
}

function createCourse(name: string, students: Student[] = []): Course {
  return {
    id: createId(),
    name: name.trim() || 'Neuer Kurs',
    students,
    selectedId: null,
  };
}

function parseNames(value: string) {
  return value
    .split(/[\n,;]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined) {
  const normalized = value?.trim().toLocaleLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (['1', 'j', 'ja', 'true', 'wahr', 'anwesend', 'present'].includes(normalized)) {
    return true;
  }

  if (['0', 'n', 'nein', 'false', 'falsch', 'fehlt', 'abwesend', 'absent'].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseCsvRows(value: string) {
  const rows: string[][] = [];
  let currentField = '';
  let currentRow: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const nextCharacter = value[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        currentField += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if ((character === ',' || character === ';') && !inQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
      continue;
    }

    if ((character === '\n' || character === '\r') && !inQuotes) {
      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }
      currentRow.push(currentField.trim());
      if (currentRow.some(Boolean)) {
        rows.push(currentRow);
      }
      currentField = '';
      currentRow = [];
      continue;
    }

    currentField += character;
  }

  currentRow.push(currentField.trim());
  if (currentRow.some(Boolean)) {
    rows.push(currentRow);
  }

  return rows;
}

function parseImportedStudentsFromCsv(value: string): ParsedImportedStudent[] {
  const rows = parseCsvRows(value);

  if (rows.length === 0) {
    return [];
  }

  const normalizedHeader = rows[0].map((field) => field.trim().toLocaleLowerCase());
  const nameColumn = normalizedHeader.findIndex((field) =>
    ['name', 'schueler', 'schüler', 'vorname', 'nachname'].includes(field),
  );
  const countColumn = normalizedHeader.findIndex((field) =>
    ['anzahl', 'zaehler', 'zähler', 'count', 'abfragen'].includes(field),
  );
  const presentColumn = normalizedHeader.findIndex((field) =>
    ['anwesend', 'present', 'anwesenheit'].includes(field),
  );
  const hasHeader = nameColumn >= 0;
  const dataRows = hasHeader ? rows.slice(1) : rows;

  return dataRows
    .map((row): ParsedImportedStudent | null => {
      const name = (row[hasHeader ? nameColumn : 0] ?? '').trim();
      const countValue = row[hasHeader ? countColumn : 1];
      const parsedCount = Number.parseInt(countValue ?? '', 10);
      const present = parseBoolean(row[hasHeader ? presentColumn : 2]);

      if (!name) {
        return null;
      }

      const importedStudent: ParsedImportedStudent = { name };

      if (Number.isFinite(parsedCount)) {
        importedStudent.count = Math.max(0, parsedCount);
      }

      if (present !== undefined) {
        importedStudent.present = present;
      }

      return importedStudent;
    })
    .filter((student): student is ParsedImportedStudent => Boolean(student));
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeLookupKey(value: string) {
  return normalizeText(value).toLocaleLowerCase();
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function interpolateNumber(value: number, inputRange: readonly number[], outputRange: readonly number[]) {
  if (value <= inputRange[0]) {
    return outputRange[0];
  }

  for (let index = 1; index < inputRange.length; index += 1) {
    if (value <= inputRange[index]) {
      const inputStart = inputRange[index - 1];
      const inputEnd = inputRange[index];
      const outputStart = outputRange[index - 1];
      const outputEnd = outputRange[index];
      const progress = inputEnd === inputStart ? 1 : (value - inputStart) / (inputEnd - inputStart);

      return outputStart + (outputEnd - outputStart) * progress;
    }
  }

  return outputRange[outputRange.length - 1];
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function randomInteger(min: number, max: number) {
  return Math.floor(randomBetween(min, max + 1));
}

function randomPercent(min: number, max: number): PercentPosition {
  return `${Math.round(randomBetween(min, max))}%`;
}

function randomFireworkColor() {
  return FIREWORK_COLORS[randomInteger(0, FIREWORK_COLORS.length - 1)];
}

function createFireworkBursts(): FireworkBurst[] {
  const burstCount = randomInteger(FIREWORK_BURST_MIN_COUNT, FIREWORK_BURST_MAX_COUNT);
  let nextDelay = randomBetween(0.01, 0.08);

  return Array.from({ length: burstCount }, () => {
    const delay = clamp(nextDelay, 0.01, 0.64);
    const color = randomFireworkColor();
    nextDelay += randomBetween(0.08, 0.22);

    return {
      color,
      delay,
      distanceScale: randomBetween(0.78, 1.22),
      explosionDuration: randomBetween(0.48, 0.62),
      id: createId(),
      launchDrift: randomBetween(-44, 44),
      launchDuration: randomBetween(0.26, 0.36),
      particleColors: FIREWORK_PARTICLE_DIRECTIONS.map(() => (Math.random() > 0.55 ? color : randomFireworkColor())),
      size: randomInteger(7, 12),
      x: randomPercent(14, 86),
      y: randomPercent(16, 52),
    };
  });
}

function normalizeStoredImageUri(imageUri: string) {
  const markerIndex = imageUri.indexOf(STUDENT_IMAGE_DIRECTORY);

  if (markerIndex >= 0) {
    return imageUri.slice(markerIndex);
  }

  return imageUri;
}

function resolveStoredImageUri(imageUri?: string) {
  if (!imageUri) {
    return undefined;
  }

  const normalizedImageUri = normalizeStoredImageUri(imageUri);

  if (normalizedImageUri.startsWith(STUDENT_IMAGE_DIRECTORY) && FileSystem.documentDirectory) {
    return `${FileSystem.documentDirectory}${normalizedImageUri}`;
  }

  return normalizedImageUri;
}

function flattenOcrLines(ocrResult: OcrResult) {
  return ocrResult.blocks
    .flatMap((block) => block.lines)
    .filter((line) => normalizeText(line.text))
    .sort((firstLine, secondLine) => {
      const topDifference = firstLine.frame.top - secondLine.frame.top;

      if (Math.abs(topDifference) > 8) {
        return topDifference;
      }

      return firstLine.frame.left - secondLine.frame.left;
    });
}

function parseCourseNameFromOcr(lines: OcrLine[]) {
  const headerLine = lines
    .slice()
    .sort((firstLine, secondLine) => firstLine.frame.top - secondLine.frame.top)
    .find((line) => {
      const text = normalizeText(line.text);
      return text.includes(',') && !/^stunde\b/i.test(text);
    });

  if (!headerLine) {
    return '';
  }

  const parts = normalizeText(headerLine.text)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return parts.slice(0, 2).join(', ');
  }

  return parts[0] ?? '';
}

function isLikelyStudentName(text: string) {
  const normalized = normalizeText(text);

  if (!normalized || normalized.length < 5 || normalized.length > 56) {
    return false;
  }

  if (/\d/.test(normalized)) {
    return false;
  }

  if (!/[a-zäöüß]/.test(normalized)) {
    return false;
  }

  if (!/^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß' -]+$/.test(normalized)) {
    return false;
  }

  const rejectedPatterns = [
    /^stunde\b/i,
    /^ks\d*$/i,
    /^bt\/k$/i,
    /^fse$/i,
    /^physik\b/i,
    /^anwesend$/i,
    /^fehlt$/i,
  ];

  if (rejectedPatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const parts = normalized.split(' ').filter(Boolean);
  return parts.length >= 2 && parts.length <= 5;
}

function estimatePhotoCropForName(line: OcrLine, imageWidth: number, imageHeight: number) {
  const lineHeight = Math.max(12, line.frame.bottom - line.frame.top);
  const textBasedSize = lineHeight * 5.45;
  const screenWidthHint = imageWidth * 0.122;
  const cropSizeHint = Math.max(textBasedSize, Math.min(screenWidthHint, textBasedSize * 1.35));
  const cropSize = clamp(Math.round(cropSizeHint), Math.round(imageWidth * 0.08), Math.round(imageWidth * 0.2));
  const textToPhotoGap = Math.max(lineHeight * 0.35, cropSize * 0.055);
  const originX = clamp(
    Math.round(line.frame.left - cropSize - textToPhotoGap),
    0,
    Math.max(0, imageWidth - cropSize),
  );
  const originY = clamp(
    Math.round(line.frame.bottom - cropSize * 0.88),
    0,
    Math.max(0, imageHeight - cropSize),
  );
  const crop: PhotoCrop = {
    originX,
    originY,
    width: Math.min(cropSize, imageWidth),
    height: Math.min(cropSize, imageHeight),
  };
  const warnings: string[] = [];

  if (line.frame.left < cropSize * 0.45) {
    warnings.push('Bildbereich unsicher');
  }

  return { crop, warnings };
}

async function recognizeTextLocally(imageUri: string): Promise<OcrResult> {
  const { recognizeText } = await import('@infinitered/react-native-mlkit-text-recognition');
  return recognizeText(imageUri) as Promise<OcrResult>;
}

async function persistStudentImage(imageUri: string) {
  if (!FileSystem.documentDirectory) {
    return imageUri;
  }

  const directory = `${FileSystem.documentDirectory}${STUDENT_IMAGE_DIRECTORY}`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => undefined);
  const filename = `${createId()}.jpg`;
  const relativePath = `${STUDENT_IMAGE_DIRECTORY}${filename}`;
  const destination = `${FileSystem.documentDirectory}${relativePath}`;
  await FileSystem.copyAsync({ from: imageUri, to: destination });
  return relativePath;
}

async function cropStudentImage(sourceUri: string, crop: PhotoCrop) {
  const croppedImage = await ImageManipulator.manipulateAsync(
    sourceUri,
    [{ crop }, { resize: { height: 512, width: 512 } }],
    { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
  );

  return persistStudentImage(croppedImage.uri);
}

function dedupeDraftStudents(students: EdupageImportStudentDraft[]) {
  const knownNames = new Set<string>();
  const dedupedStudents: EdupageImportStudentDraft[] = [];

  students.forEach((student) => {
    const key = normalizeLookupKey(student.name);

    if (!key || knownNames.has(key)) {
      return;
    }

    knownNames.add(key);
    dedupedStudents.push(student);
  });

  return dedupedStudents;
}

async function processEdupageAsset(asset: ImagePicker.ImagePickerAsset) {
  const ocrResult = await recognizeTextLocally(asset.uri);
  const lines = flattenOcrLines(ocrResult);
  const courseName = parseCourseNameFromOcr(lines);
  const warnings: string[] = [];
  const students: EdupageImportStudentDraft[] = [];

  if (!courseName) {
    warnings.push('Kursname nicht sicher erkannt');
  }

  for (const line of lines) {
    const name = normalizeText(line.text);

    if (!isLikelyStudentName(name)) {
      continue;
    }

    const { crop, warnings: cropWarnings } = estimatePhotoCropForName(line, asset.width, asset.height);
    let imageUri: string | undefined;
    const studentWarnings = [...cropWarnings];

    try {
      imageUri = await cropStudentImage(asset.uri, crop);
    } catch {
      studentWarnings.push('Foto konnte nicht ausgeschnitten werden');
    }

    students.push({
      id: createId(),
      name,
      imageUri,
      selected: true,
      warnings: studentWarnings,
    });
  }

  if (students.length === 0) {
    warnings.push('Keine Schülernamen erkannt');
  }

  return {
    courseName,
    students,
    warnings,
  };
}

function sanitizeStudents(value: unknown): Student[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): Student | null => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as Partial<Student>;
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';

      if (!name) {
        return null;
      }

      const student: Student = {
        id: typeof candidate.id === 'string' && candidate.id ? candidate.id : createId(),
        name,
        count: Number.isFinite(candidate.count) ? Math.max(0, Math.floor(candidate.count ?? 0)) : 0,
        present: true,
      };

      if (typeof candidate.imageUri === 'string') {
        student.imageUri = normalizeStoredImageUri(candidate.imageUri);
      }

      if (typeof candidate.imageBrightness === 'number' && Number.isFinite(candidate.imageBrightness)) {
        student.imageBrightness = clamp(candidate.imageBrightness, -0.45, 0.45);
      }

      return student;
    })
    .filter((student): student is Student => Boolean(student));
}

function sanitizeCourses(value: unknown): Course[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as Partial<Course>;
      const students = sanitizeStudents(candidate.students);
      const selectedId =
        typeof candidate.selectedId === 'string' && students.some((student) => student.id === candidate.selectedId)
          ? candidate.selectedId
          : null;

      return {
        id: typeof candidate.id === 'string' && candidate.id ? candidate.id : createId(),
        name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : 'Unbenannter Kurs',
        students,
        selectedId,
      };
    })
    .filter((course): course is Course => Boolean(course));
}

function parseStoredData(storedClass: string | null): StoredData {
  if (!storedClass) {
    return {
      activeCourseId: null,
      courses: [],
      selectionRevealDelayMs: DEFAULT_SELECTION_REVEAL_DELAY_MS,
    };
  }

  const parsed = JSON.parse(storedClass) as Partial<StoredData & StoredClass>;
  const courses = sanitizeCourses(parsed.courses);
  const selectionRevealDelayMs = sanitizeSelectionRevealDelay(parsed.selectionRevealDelayMs);

  if (Array.isArray(parsed.courses) && courses.length === 0) {
    return {
      activeCourseId: null,
      courses: [],
      selectionRevealDelayMs,
    };
  }

  if (courses.length > 0) {
    const activeCourseId =
      typeof parsed.activeCourseId === 'string' && courses.some((course) => course.id === parsed.activeCourseId)
        ? parsed.activeCourseId
        : courses[0].id;

    return {
      activeCourseId,
      courses,
      selectionRevealDelayMs,
    };
  }

  const legacyStudents = sanitizeStudents(parsed.students);
  const selectedId =
    typeof parsed.selectedId === 'string' && legacyStudents.some((student) => student.id === parsed.selectedId)
      ? parsed.selectedId
      : null;

  if (legacyStudents.length === 0) {
    return {
      activeCourseId: null,
      courses: [],
      selectionRevealDelayMs,
    };
  }

  const migratedCourse = {
    ...createCourse('Klasse 1', legacyStudents),
    selectedId,
  };

  return {
    activeCourseId: migratedCourse.id,
    courses: [migratedCourse],
    selectionRevealDelayMs,
  };
}

async function isSecureStorageAvailable() {
  if (Platform.OS === 'web') {
    return false;
  }

  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

async function readStoredClass() {
  const secureStorageAvailable = await isSecureStorageAvailable();

  if (secureStorageAvailable) {
    const secureStoredClass = await SecureStore.getItemAsync(SECURE_STORAGE_KEY, SECURE_STORE_OPTIONS);

    if (secureStoredClass) {
      return {
        secureStorageAvailable,
        storedClass: secureStoredClass,
      };
    }
  }

  const legacyStoredClass = await AsyncStorage.getItem(STORAGE_KEY);

  return {
    secureStorageAvailable,
    storedClass: legacyStoredClass,
  };
}

async function writeStoredClass(value: StoredData) {
  const serializedClass = JSON.stringify(value);

  if (await isSecureStorageAvailable()) {
    await SecureStore.setItemAsync(SECURE_STORAGE_KEY, serializedClass, SECURE_STORE_OPTIONS);
    await AsyncStorage.removeItem(STORAGE_KEY);
    return;
  }

  await AsyncStorage.setItem(STORAGE_KEY, serializedClass);
}

async function readDocumentAssetText(asset: DocumentPicker.DocumentPickerAsset) {
  if (Platform.OS === 'web' && asset.file) {
    return asset.file.text();
  }

  const file = new ExpoFile(asset.uri);
  return file.text();
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];

  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }

  let x = 0.9999999999998099;
  const shiftedValue = value - 1;

  coefficients.forEach((coefficient, index) => {
    x += coefficient / (shiftedValue + index + 1);
  });

  const t = shiftedValue + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shiftedValue + 0.5) * Math.log(t) - t + Math.log(x);
}

function createInverseFactorials(length: number) {
  const inverseFactorials = [1];

  for (let index = 1; index < length; index += 1) {
    inverseFactorials[index] = inverseFactorials[index - 1] / index;
  }

  return inverseFactorials;
}

function convolveWithInverseFactorials(coefficients: number[], terms: number) {
  const inverseFactorials = createInverseFactorials(terms);
  const nextCoefficients = Array.from({ length: coefficients.length + terms - 1 }, () => 0);

  coefficients.forEach((coefficient, coefficientIndex) => {
    inverseFactorials.forEach((inverseFactorial, termIndex) => {
      nextCoefficients[coefficientIndex + termIndex] += coefficient * inverseFactorial;
    });
  });

  return nextCoefficients;
}

function calculateSelectionProbabilities(candidates: Student[]) {
  const presentCandidates = candidates.filter((student) => student.name.trim());
  const probabilities: Record<string, number> = {};

  candidates.forEach((student) => {
    probabilities[student.id] = 0;
  });

  if (presentCandidates.length === 0) {
    return probabilities;
  }

  if (presentCandidates.length === 1) {
    probabilities[presentCandidates[0].id] = 1;
    return probabilities;
  }

  const drawCount = presentCandidates.length;
  const logDrawCount = Math.log(drawCount);

  presentCandidates.forEach((targetStudent) => {
    const targetHits = targetStudent.count + 1;
    let coefficients = [1];
    let logScale = 0;

    presentCandidates.forEach((student) => {
      if (student.id === targetStudent.id) {
        return;
      }

      coefficients = convolveWithInverseFactorials(coefficients, student.count + 1);
      const maxCoefficient = Math.max(...coefficients);

      if (maxCoefficient > 0 && Number.isFinite(maxCoefficient)) {
        coefficients = coefficients.map((coefficient) => coefficient / maxCoefficient);
        logScale += Math.log(maxCoefficient);
      }
    });

    let probability = 0;

    coefficients.forEach((coefficient, skippedHits) => {
      if (coefficient <= 0) {
        return;
      }

      const logTerm =
        logScale +
        Math.log(coefficient) +
        logGamma(skippedHits + targetHits) -
        logGamma(targetHits) -
        (skippedHits + targetHits) * logDrawCount;
      probability += Math.exp(logTerm);
    });

    probabilities[targetStudent.id] = Math.max(0, Math.min(1, probability));
  });

  return probabilities;
}

function formatProbability(probability: number) {
  if (probability <= 0) {
    return '0,0 %';
  }

  if (probability < 0.001) {
    return '< 0,1 %';
  }

  const percentage = probability * 100;

  return `${percentage.toLocaleString('de-DE', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })} %`;
}

function getChanceLevel(probability: number, averageProbability: number): ChanceLevel {
  if (averageProbability <= 0) {
    return 'low';
  }

  if (probability >= averageProbability * 1.25) {
    return 'high';
  }

  if (probability <= averageProbability * 0.75) {
    return 'low';
  }

  return 'medium';
}

function getInitials(name: string) {
  return normalizeText(name)
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? '')
    .join('');
}

function getImageSize(uri: string) {
  return new Promise<{ height: number; width: number }>((resolve, reject) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ height, width }),
      (error) => reject(error),
    );
  });
}

function StudentImageView({
  imageStyle,
  placeholderStyle,
  placeholderTextStyle,
  student,
}: {
  imageStyle: StyleProp<ImageStyle & ViewStyle>;
  placeholderStyle?: StyleProp<ViewStyle>;
  placeholderTextStyle?: StyleProp<TextStyle>;
  student: Pick<Student, 'name' | 'imageBrightness' | 'imageUri'> | null;
}) {
  const imageUri = resolveStoredImageUri(student?.imageUri);
  const brightness = clamp(student?.imageBrightness ?? 0, -0.45, 0.45);

  if (!imageUri) {
    return (
      <View style={[placeholderStyle, imageStyle as StyleProp<ViewStyle>]}>
        <Text style={placeholderTextStyle}>{student ? getInitials(student.name) || '?' : '?'}</Text>
      </View>
    );
  }

  return (
    <View style={[imageStyle as StyleProp<ViewStyle>, styles.adjustedImageFrame]}>
      <Image
        resizeMode="cover"
        source={{ uri: imageUri }}
        style={styles.adjustedImage}
      />
      {brightness !== 0 && (
        <View
          pointerEvents="none"
          style={[
            styles.imageBrightnessOverlay,
            {
              backgroundColor: brightness > 0 ? '#FFFFFF' : '#000000',
              opacity: Math.abs(brightness),
            },
          ]}
        />
      )}
    </View>
  );
}

function confirmDestructiveAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    const confirm = (globalThis as unknown as { confirm?: (text: string) => boolean }).confirm;

    if (!confirm || confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }

    return;
  }

  Alert.alert(title, message, [
    { text: 'Abbrechen', style: 'cancel' },
    { text: 'Löschen', onPress: onConfirm, style: 'destructive' },
  ]);
}

export default function App() {
  const { height, width } = useWindowDimensions();
  const selectionRunRef = useRef<SelectionRun | null>(null);
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionPulseAnim = useRef(new Animated.Value(0)).current;
  const selectionRevealAnim = useRef(new Animated.Value(1)).current;
  const selectionSweepAnim = useRef(new Animated.Value(0)).current;
  const [courses, setCourses] = useState<Course[]>([]);
  const [activeCourseId, setActiveCourseId] = useState<string | null>(null);
  const [newCourseName, setNewCourseName] = useState('');
  const [newName, setNewName] = useState('');
  const [importText, setImportText] = useState('');
  const [message, setMessage] = useState('Bereit');
  const [hydrated, setHydrated] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [currentView, setCurrentView] = useState<'courses' | 'students'>('courses');
  const [selectionOverlayVisible, setSelectionOverlayVisible] = useState(false);
  const [selectionPhase, setSelectionPhase] = useState<SelectionPhase>('idle');
  const [rollingCandidate, setRollingCandidate] = useState<RollingCandidate | null>(null);
  const [rollingDetailsVisible, setRollingDetailsVisible] = useState(false);
  const [pendingCandidate, setPendingCandidate] = useState<SelectionStudentSnapshot | null>(null);
  const [skippedCandidates, setSkippedCandidates] = useState<SkippedCandidate[]>([]);
  const [celebrationActive, setCelebrationActive] = useState(false);
  const [celebrationProgress, setCelebrationProgress] = useState(0);
  const [fireworkBursts, setFireworkBursts] = useState<FireworkBurst[]>(() => createFireworkBursts());
  const [edupageDraft, setEdupageDraft] = useState<EdupageImportDraft | null>(null);
  const [edupageImportBusy, setEdupageImportBusy] = useState(false);
  const [imageEditor, setImageEditor] = useState<ImageEditorState | null>(null);
  const [imageEditorBusy, setImageEditorBusy] = useState(false);
  const [infoVisible, setInfoVisible] = useState(false);
  const [studentSortMode, setStudentSortMode] = useState<StudentSortMode>('name');
  const [selectionRevealDelayMs, setSelectionRevealDelayMs] = useState(DEFAULT_SELECTION_REVEAL_DELAY_MS);
  const compactLayout = width < 560;
  const compactSelectionLayout = width < 560 || height < 760;
  const selectionActive = selectionPhase !== 'idle';
  const editControlsDisabled = !editMode || selectionActive;
  const importDisabled = editControlsDisabled || edupageImportBusy;
  const activeCourse = useMemo(
    () => courses.find((course) => course.id === activeCourseId) ?? null,
    [activeCourseId, courses],
  );
  const students = activeCourse?.students ?? [];
  const selectedId = activeCourse?.selectedId ?? null;
  const totalStudentCount = useMemo(
    () => courses.reduce((sum, course) => sum + course.students.length, 0),
    [courses],
  );

  useEffect(() => {
    let mounted = true;

    async function loadStoredClass() {
      try {
        const { secureStorageAvailable, storedClass } = await readStoredClass();

        if (!mounted) {
          return;
        }

        if (!storedClass) {
          const initialData = parseStoredData(null);

          setCourses(initialData.courses);
          setActiveCourseId(initialData.activeCourseId);
          setSelectionRevealDelayMs(initialData.selectionRevealDelayMs);
          setHydrated(true);
          setMessage(secureStorageAvailable ? 'Verschlüsselte Speicherung aktiv.' : 'Web-Speicherung aktiv.');
          return;
        }

        const restoredData = parseStoredData(storedClass);

        setCourses(restoredData.courses);
        setActiveCourseId(restoredData.activeCourseId);
        setSelectionRevealDelayMs(restoredData.selectionRevealDelayMs);
        setMessage(secureStorageAvailable ? 'Verschlüsselte Speicherung aktiv.' : 'Web-Speicherung aktiv.');
      } catch {
        setMessage('Gespeicherte Daten konnten nicht geladen werden.');
      } finally {
        if (mounted) {
          setHydrated(true);
        }
      }
    }

    loadStoredClass();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (selectionTimerRef.current) {
        clearTimeout(selectionTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (hydrated && currentView === 'students' && !activeCourse) {
      setCurrentView('courses');
    }
  }, [activeCourse, currentView, hydrated]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    writeStoredClass({
      activeCourseId: activeCourse?.id ?? activeCourseId,
      courses,
      selectionRevealDelayMs,
    }).catch(() => {
      setMessage('Speichern ist gerade nicht möglich.');
    });
  }, [activeCourse?.id, activeCourseId, courses, hydrated, selectionRevealDelayMs]);

  const selectedStudent = useMemo(
    () => students.find((student) => student.id === selectedId) ?? null,
    [selectedId, students],
  );

  const presentStudents = useMemo(
    () => students.filter((student) => student.name.trim()),
    [students],
  );

  const selectionProbabilities = useMemo(() => calculateSelectionProbabilities(students), [students]);
  const selectedDraftStudentCount = edupageDraft?.students.filter((student) => student.selected).length ?? 0;
  const averageSelectionProbability = students.length > 0 ? 1 / students.length : 0;
  const selectionRevealDelayLabel = `${(selectionRevealDelayMs / 1000).toLocaleString('de-DE', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })} s`;
  const sortedStudents = useMemo(
    () =>
      students.slice().sort((firstStudent, secondStudent) => {
        if (studentSortMode === 'chance') {
          const firstProbability = selectionProbabilities[firstStudent.id] ?? 0;
          const secondProbability = selectionProbabilities[secondStudent.id] ?? 0;
          const probabilityDifference = secondProbability - firstProbability;

          if (Math.abs(probabilityDifference) > 0.000001) {
            return probabilityDifference;
          }
        }

        return firstStudent.name.localeCompare(secondStudent.name, 'de', { sensitivity: 'base' });
      }),
    [selectionProbabilities, studentSortMode, students],
  );
  const skippedCandidateCount = skippedCandidates.length;

  const displayedName =
    pendingCandidate?.name ??
    rollingCandidate?.name ??
    (selectionPhase === 'rolling' ? 'Wer wird es?' : selectedStudent?.name ?? 'Noch niemand');
  const selectionStageText =
    selectionPhase === 'rolling'
      ? rollingCandidate
        ? !rollingDetailsVisible
          ? 'Treffer prüfen'
          : rollingCandidate.remainingBefore > 0
          ? 'Zähler prüfen'
          : 'Kandidat im Fokus'
        : 'Namen mischen'
      : selectionPhase === 'confirming'
        ? 'Anwesenheit'
        : selectedStudent
          ? 'Ausgewählt'
          : 'Bereit';
  const displayedMeta =
    selectionPhase === 'rolling'
      ? rollingCandidate
        ? rollingCandidate.remainingBefore > 0
          ? rollingDetailsVisible
            ? `${rollingCandidate.remainingBefore} Treffer übrig - weiter...`
            : 'Bisherige Treffer werden geprüft...'
          : rollingDetailsVisible
            ? 'Kandidat gefunden'
            : 'Bisherige Treffer werden geprüft...'
        : 'Auswahl läuft...'
      : selectionPhase === 'confirming' && pendingCandidate
        ? 'Anwesenheit bestätigen'
        : selectedStudent
          ? `${selectedStudent.count}. Abfrage`
          : presentStudents.length === 0
            ? 'Liste anlegen'
            : `${presentStudents.length} mögliche Kandidaten`;
  const highlightedStudentId = pendingCandidate?.id ?? rollingCandidate?.id ?? selectedId;
  const displayedStudent = students.find((student) => student.id === highlightedStudentId) ?? null;
  const selectionPulseStyle = {
    opacity: selectionPulseAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [0.24, 0.72],
    }),
    transform: [
      {
        scale: selectionPulseAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [0.9, 1.08],
        }),
      },
    ],
  };
  const selectionRevealStyle = {
    opacity: selectionRevealAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [0.58, 1],
    }),
    transform: [
      {
        translateY: selectionRevealAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [18, 0],
        }),
      },
      {
        scale: selectionRevealAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [0.9, 1],
        }),
      },
    ],
  };
  const selectionSweepStyle = {
    opacity: selectionSweepAnim.interpolate({
      inputRange: [0, 0.5, 1],
      outputRange: [0.18, 1, 0.18],
    }),
    transform: [
      {
        translateX: selectionSweepAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [-92, 92],
        }),
      },
    ],
  };
  const selectionPulseToneStyle =
    selectionPhase === 'rolling' && !rollingDetailsVisible
      ? styles.selectionPulseRingAlert
      : rollingCandidate && rollingCandidate.remainingBefore > 0 && rollingDetailsVisible
        ? styles.selectionPulseRingClear
        : styles.selectionPulseRingFound;
  const renderFireworkParticle = (
    burst: FireworkBurst,
    direction: (typeof FIREWORK_PARTICLE_DIRECTIONS)[number],
    particleIndex: number,
  ) => {
    const cycleStart = Math.min(burst.delay + burst.launchDuration, 0.9);
    const cycleMiddle = Math.min(cycleStart + 0.16, 0.97);
    const cycleEnd = Math.min(cycleStart + burst.explosionDuration, 0.995);
    const distance = (compactSelectionLayout ? 46 + burst.size * 3 : 68 + burst.size * 4) * burst.distanceScale;
    const color = burst.particleColors[particleIndex] ?? burst.color;

    return (
      <Animated.View
        key={`${burst.id}-${particleIndex}`}
        style={[
          styles.fireworkParticle,
          {
            backgroundColor: color,
            height: burst.size,
            left: burst.x,
            opacity: interpolateNumber(celebrationProgress, [0, cycleStart, cycleMiddle, cycleEnd, 1], [0, 0, 1, 0, 0]),
            top: burst.y,
            transform: [
              {
                translateX: interpolateNumber(celebrationProgress, [0, cycleStart, cycleEnd, 1], [0, 0, direction[0] * distance, 0]),
              },
              {
                translateY: interpolateNumber(celebrationProgress, [0, cycleStart, cycleEnd, 1], [0, 0, direction[1] * distance, 0]),
              },
              {
                scale: interpolateNumber(celebrationProgress, [0, cycleStart, cycleMiddle, cycleEnd, 1], [0.65, 0.65, 1.45, 0.45, 0.65]),
              },
            ],
            width: burst.size,
          },
        ]}
      />
    );
  };

  const renderFireworkRocket = (burst: FireworkBurst) => {
    const launchStart = Math.max(burst.delay, 0.001);
    const launchEnd = Math.min(launchStart + burst.launchDuration, 0.9);
    const fadeEnd = Math.min(launchEnd + 0.05, 1);
    const launchDistance = compactSelectionLayout ? 420 : 620;
    const trailLength = (compactSelectionLayout ? 34 : 48) + burst.size * 2;

    return (
      <Animated.View
        key={`rocket-${burst.id}`}
        style={[
          styles.fireworkRocket,
          {
            left: burst.x,
            opacity: interpolateNumber(celebrationProgress, [0, launchStart, launchEnd, fadeEnd, 1], [0, 0, 1, 0, 0]),
            top: burst.y,
            transform: [
              {
                translateY: interpolateNumber(celebrationProgress, [0, launchStart, launchEnd, 1], [launchDistance, launchDistance, 0, launchDistance]),
              },
              {
                translateX: interpolateNumber(celebrationProgress, [0, launchStart, launchEnd, 1], [burst.launchDrift, burst.launchDrift, 0, burst.launchDrift]),
              },
            ],
          },
        ]}
      >
        <View
          style={[
            styles.fireworkRocketHead,
            {
              backgroundColor: burst.color,
              borderRadius: (burst.size + 5) / 2,
              height: burst.size + 5,
              width: burst.size + 5,
            },
          ]}
        />
        <View
          style={[
            styles.fireworkRocketTrail,
            {
              backgroundColor: burst.color,
              height: trailLength,
            },
          ]}
        />
      </Animated.View>
    );
  };

  useEffect(() => {
    let pulseAnimation: Animated.CompositeAnimation | null = null;
    let sweepAnimation: Animated.CompositeAnimation | null = null;

    if (selectionOverlayVisible && selectionPhase === 'rolling') {
      selectionPulseAnim.setValue(0);
      selectionSweepAnim.setValue(0);
      pulseAnimation = Animated.loop(
        Animated.sequence([
          Animated.timing(selectionPulseAnim, {
            duration: 520,
            easing: Easing.out(Easing.cubic),
            toValue: 1,
            useNativeDriver: true,
          }),
          Animated.timing(selectionPulseAnim, {
            duration: 520,
            easing: Easing.in(Easing.cubic),
            toValue: 0,
            useNativeDriver: true,
          }),
        ]),
      );
      sweepAnimation = Animated.loop(
        Animated.timing(selectionSweepAnim, {
          duration: 1150,
          easing: Easing.inOut(Easing.quad),
          toValue: 1,
          useNativeDriver: true,
        }),
      );
      pulseAnimation.start();
      sweepAnimation.start();
    } else {
      Animated.timing(selectionPulseAnim, {
        duration: 220,
        easing: Easing.out(Easing.cubic),
        toValue: selectionOverlayVisible && selectionPhase === 'confirming' ? 1 : 0,
        useNativeDriver: true,
      }).start();
    }

    return () => {
      pulseAnimation?.stop();
      sweepAnimation?.stop();
    };
  }, [selectionOverlayVisible, selectionPhase, selectionPulseAnim, selectionSweepAnim]);

  useEffect(() => {
    if (!selectionOverlayVisible) {
      selectionRevealAnim.setValue(1);
      return;
    }

    selectionRevealAnim.setValue(0);
    Animated.spring(selectionRevealAnim, {
      damping: 13,
      mass: 0.8,
      stiffness: 130,
      toValue: 1,
      useNativeDriver: true,
    }).start();
  }, [
    pendingCandidate?.id,
    rollingCandidate?.id,
    rollingCandidate?.remainingBefore,
    selectedId,
    selectionOverlayVisible,
    selectionRevealAnim,
  ]);

  useEffect(() => {
    if (!celebrationActive || !selectionOverlayVisible) {
      setCelebrationProgress(0);
      return undefined;
    }

    let cycleStartTime = Date.now();
    setFireworkBursts(createFireworkBursts());
    setCelebrationProgress(0);

    const celebrationTicker = setInterval(() => {
      const elapsedMs = Date.now() - cycleStartTime;

      if (elapsedMs >= FIREWORK_LOOP_DURATION_MS) {
        cycleStartTime = Date.now();
        setFireworkBursts(createFireworkBursts());
        setCelebrationProgress(0);
        return;
      }

      setCelebrationProgress(elapsedMs / FIREWORK_LOOP_DURATION_MS);
    }, 40);

    return () => {
      clearInterval(celebrationTicker);
    };
  }, [celebrationActive, selectionOverlayVisible]);

  function setStudents(updater: Student[] | ((currentStudents: Student[]) => Student[])) {
    if (!activeCourse) {
      return;
    }

    setCourses((currentCourses) =>
      currentCourses.map((course) => {
        if (course.id !== activeCourse.id) {
          return course;
        }

        const nextStudents = typeof updater === 'function' ? updater(course.students) : updater;
        const selectedStudentStillExists =
          course.selectedId !== null && nextStudents.some((student) => student.id === course.selectedId);

        return {
          ...course,
          selectedId: selectedStudentStillExists ? course.selectedId : null,
          students: nextStudents,
        };
      }),
    );
  }

  function setSelectedId(selectedStudentId: string | null) {
    if (!activeCourse) {
      return;
    }

    setCourses((currentCourses) =>
      currentCourses.map((course) =>
        course.id === activeCourse.id
          ? {
              ...course,
              selectedId: selectedStudentId,
            }
          : course,
      ),
    );
  }

  function updateStudent(id: string, updater: (student: Student) => Student) {
    setStudents((currentStudents) =>
      currentStudents.map((student) => (student.id === id ? updater(student) : student)),
    );
  }

  function requireEditMode() {
    if (editMode) {
      return true;
    }

    setMessage('Bearbeitungsmodus einschalten, um die Liste zu ändern.');
    return false;
  }

  function selectCourse(courseId: string) {
    if (selectionActive) {
      return;
    }

    setActiveCourseId(courseId);
    setCurrentView('students');
    setRollingCandidate(null);
    setRollingDetailsVisible(false);
    setPendingCandidate(null);
    setSkippedCandidates([]);
    setCelebrationActive(false);
    setSelectionPhase('idle');
  }

  function showCourseOverview() {
    if (selectionActive) {
      return;
    }

    setCurrentView('courses');
    setEdupageDraft(null);
  }

  function addCourse() {
    if (!requireEditMode()) {
      return;
    }

    if (selectionActive) {
      return;
    }

    const name = newCourseName.trim();

    if (!name) {
      setMessage('Kursname fehlt.');
      return;
    }

    if (courses.some((course) => course.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) {
      setMessage(`${name} ist schon vorhanden.`);
      return;
    }

    const course = createCourse(name);
    setCourses((currentCourses) => [...currentCourses, course]);
    setActiveCourseId(course.id);
    setCurrentView('students');
    setNewCourseName('');
    setMessage(`${name} hinzugefügt.`);
  }

  function renameActiveCourse(name: string) {
    if (!editMode) {
      return;
    }

    if (!activeCourse) {
      return;
    }

    setCourses((currentCourses) =>
      currentCourses.map((course) => (course.id === activeCourse.id ? { ...course, name } : course)),
    );
  }

  function deleteActiveCourse() {
    if (!requireEditMode()) {
      return;
    }

    if (selectionActive || !activeCourse) {
      return;
    }

    const courseToDelete = activeCourse;

    confirmDestructiveAction(
      'Kurs löschen',
      `${courseToDelete.name} wirklich löschen? Schüler, Bilder und Zähler dieses Kurses werden entfernt.`,
      () => {
        const courseIndex = courses.findIndex((course) => course.id === courseToDelete.id);
        const nextCourses = courses.filter((course) => course.id !== courseToDelete.id);
        const nextActiveCourse = nextCourses[Math.max(0, courseIndex - 1)] ?? nextCourses[0] ?? null;

        setCourses(nextCourses);
        setActiveCourseId(nextActiveCourse?.id ?? null);
        setCurrentView(nextActiveCourse ? 'students' : 'courses');
        setMessage(`${courseToDelete.name} gelöscht.`);
      },
    );
  }

  function changeSelectionRevealDelay(deltaMs: number) {
    if (selectionActive) {
      setMessage('Während der laufenden Auswahl bleibt die Zeit unverändert.');
      return;
    }

    setSelectionRevealDelayMs((currentDelay) => sanitizeSelectionRevealDelay(currentDelay + deltaMs));
  }

  function clearSelectionTimer() {
    if (selectionTimerRef.current) {
      clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = null;
    }
  }

  function scheduleNextSelectionStep(token: number, delay = DRAW_DELAY_MS) {
    clearSelectionTimer();
    selectionTimerRef.current = setTimeout(() => {
      advanceSelection(token);
    }, delay);
  }

  function finishSelectionWithoutCandidate(text: string) {
    clearSelectionTimer();
    selectionRunRef.current = null;
    setSelectionPhase('idle');
    setRollingCandidate(null);
    setRollingDetailsVisible(false);
    setPendingCandidate(null);
    setSelectedId(null);
    setCelebrationActive(false);
    setMessage(text);
  }

  function closeSelectionOverlay() {
    const hadActiveSelection = selectionPhase !== 'idle';

    clearSelectionTimer();
    selectionRunRef.current = null;
    setSelectionPhase('idle');
    setRollingCandidate(null);
    setRollingDetailsVisible(false);
    setPendingCandidate(null);
    setSkippedCandidates([]);
    setCelebrationActive(false);
    setSelectionOverlayVisible(false);

    if (hadActiveSelection) {
      setMessage('Auswahl abgebrochen.');
    }
  }

  function advanceSelection(token: number) {
    const run = selectionRunRef.current;

    if (!run || run.token !== token) {
      return;
    }

    const candidates = run.students.filter(
      (student) => student.name.trim() && !run.absentIds.has(student.id),
    );

    if (candidates.length === 0) {
      finishSelectionWithoutCandidate('Keine weiteren Schüler für diese Abfrage verfügbar.');
      return;
    }

    run.draws += 1;

    if (run.draws > 10000) {
      finishSelectionWithoutCandidate('Die Auswahl wurde abgebrochen. Bitte prüfe die Liste.');
      return;
    }

    const candidate = candidates[Math.floor(Math.random() * candidates.length)];
    const remainingBefore = run.remainingCounts[candidate.id] ?? 0;
    const shownCandidate = {
      id: candidate.id,
      name: candidate.name,
      remainingBefore,
    };

    setSelectionPhase('rolling');
    setRollingCandidate(shownCandidate);
    setRollingDetailsVisible(false);
    setPendingCandidate(null);

    if (remainingBefore > 0) {
      run.remainingCounts[candidate.id] = remainingBefore - 1;
      setMessage(`${candidate.name} wird geprüft...`);
      const detailDelay = getRollingDetailDelay(
        run.students.reduce((sum, student) => sum + student.count, 0),
        selectionRevealDelayMs,
      );
      clearSelectionTimer();
      selectionTimerRef.current = setTimeout(() => {
        const currentRun = selectionRunRef.current;

        if (!currentRun || currentRun.token !== token) {
          return;
        }

        setRollingDetailsVisible(true);
        setSkippedCandidates((currentCandidates) => [
          { ...shownCandidate, key: `${token}-${run.draws}` },
          ...currentCandidates,
        ]);
        setMessage(`${candidate.name} war schon dran - weiter.`);
        scheduleNextSelectionStep(token, 760 + Math.min(run.draws, 4) * 120);
      }, detailDelay);
      return;
    }

    clearSelectionTimer();
    setMessage(`${candidate.name} wird geprüft...`);
    selectionTimerRef.current = setTimeout(() => {
      const currentRun = selectionRunRef.current;

      if (!currentRun || currentRun.token !== token) {
        return;
      }

      setRollingDetailsVisible(true);
      setPendingCandidate(candidate);
      setSelectionPhase('confirming');
      setMessage(`Ist ${candidate.name} anwesend?`);
    }, selectionRevealDelayMs);
  }

  function startSelection() {
    const candidates = students.filter((student) => student.name.trim());

    if (candidates.length === 0) {
      setMessage('Keine Schüler in der Liste.');
      setSelectedId(null);
      return;
    }

    const token = Date.now();

    selectionRunRef.current = {
      absentIds: new Set(),
      draws: 0,
      remainingCounts: Object.fromEntries(candidates.map((student) => [student.id, student.count])),
      students: candidates.map((student) => ({
        id: student.id,
        name: student.name,
        count: student.count,
        present: true,
      })),
      token,
    };

    clearSelectionTimer();
    setSelectedId(null);
    setPendingCandidate(null);
    setRollingCandidate(null);
    setRollingDetailsVisible(false);
    setSkippedCandidates([]);
    setCelebrationActive(false);
    setSelectionOverlayVisible(true);
    setSelectionPhase('rolling');
    setMessage('Namen werden gemischt...');
    scheduleNextSelectionStep(token, INITIAL_SHUFFLE_DELAY_MS);
  }

  function answerPresence(isPresent: boolean) {
    if (!pendingCandidate) {
      return;
    }

    const candidate = pendingCandidate;

    if (isPresent) {
      clearSelectionTimer();
      selectionRunRef.current = null;
      setStudents((currentStudents) =>
        currentStudents.map((student) =>
          student.id === candidate.id
            ? { ...student, count: student.count + 1, present: true }
            : { ...student, present: true },
        ),
      );
      setSelectedId(candidate.id);
      setPendingCandidate(null);
      setRollingCandidate(null);
      setRollingDetailsVisible(false);
      setSkippedCandidates([]);
      setCelebrationActive(true);
      setSelectionPhase('idle');
      setMessage(`${candidate.name} wurde ausgewählt.`);
      return;
    }

    const run = selectionRunRef.current;

    if (!run) {
      finishSelectionWithoutCandidate(`${candidate.name} ist nicht anwesend.`);
      return;
    }

    run.absentIds.add(candidate.id);
    setSelectedId(null);
    setPendingCandidate(null);
    setRollingCandidate({
      id: candidate.id,
      name: candidate.name,
      remainingBefore: 0,
    });
    setRollingDetailsVisible(false);
    setCelebrationActive(false);
    setSelectionPhase('rolling');
    setMessage(`${candidate.name} fehlt - Auswahl läuft weiter.`);
    scheduleNextSelectionStep(run.token, ABSENT_RESTART_DELAY_MS);
  }

  function addStudent() {
    if (!requireEditMode()) {
      return;
    }

    if (!activeCourse) {
      setMessage('Erst einen Kurs anlegen oder per Edupage importieren.');
      return;
    }

    const name = newName.trim();

    if (!name) {
      setMessage('Name fehlt.');
      return;
    }

    if (students.some((student) => student.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) {
      setMessage(`${name} ist schon in der Liste.`);
      return;
    }

    setStudents((currentStudents) => [...currentStudents, createStudent(name)]);
    setNewName('');
    setMessage(`${name} hinzugefügt.`);
  }

  function appendImportedStudents(importedStudents: ParsedImportedStudent[], emptyMessage: string) {
    if (!requireEditMode()) {
      return 0;
    }

    if (!activeCourse) {
      setMessage('Erst einen Kurs anlegen oder per Edupage importieren.');
      return 0;
    }

    if (importedStudents.length === 0) {
      setMessage(emptyMessage);
      return 0;
    }

    const knownNames = new Set(students.map((student) => student.name.toLocaleLowerCase()));
    const uniqueStudents = importedStudents.filter((student) => {
      const key = student.name.toLocaleLowerCase();

      if (knownNames.has(key)) {
        return false;
      }

      knownNames.add(key);
      return true;
    });

    if (uniqueStudents.length === 0) {
      setMessage('Alle importierten Namen sind schon vorhanden.');
      return 0;
    }

    setStudents((currentStudents) => [
      ...currentStudents,
      ...uniqueStudents.map((student) => ({
        ...createStudent(student.name, student.count ?? 0),
        present: student.present ?? true,
      })),
    ]);
    setMessage(`${uniqueStudents.length} Namen importiert.`);
    return uniqueStudents.length;
  }

  function importStudents() {
    const importedCount = appendImportedStudents(
      parseNames(importText).map((name) => ({ name })),
      'Keine Namen gefunden.',
    );

    if (importedCount > 0) {
      setImportText('');
    }
  }

  async function importStudentsFromCsvFile() {
    if (!requireEditMode()) {
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: ['text/csv', 'text/comma-separated-values', 'text/plain', 'application/vnd.ms-excel'],
      });

      if (result.canceled) {
        return;
      }

      const asset = result.assets[0];
      const fileText = await readDocumentAssetText(asset);
      const importedCount = appendImportedStudents(parseImportedStudentsFromCsv(fileText), 'Keine CSV-Namen gefunden.');

      if (importedCount > 0) {
        setMessage(`${importedCount} Namen aus ${asset.name} importiert.`);
      }
    } catch {
      setMessage('CSV-Datei konnte nicht gelesen werden.');
    }
  }

  async function openEdupageImportReview(assets: ImagePicker.ImagePickerAsset[]) {
      const processedAssets = [];

      for (const asset of assets) {
        processedAssets.push(await processEdupageAsset(asset));
      }

      const courseName =
        processedAssets.find((asset) => asset.courseName)?.courseName ?? activeCourse?.name ?? 'Edupage-Kurs';
      const draftStudents = dedupeDraftStudents(processedAssets.flatMap((asset) => asset.students));
      const warnings = processedAssets.flatMap((asset) => asset.warnings);

      setEdupageDraft({
        id: createId(),
        courseName,
        sourceImageCount: assets.length,
        students: draftStudents,
        warnings,
      });
      setMessage(`${draftStudents.length} Schüler aus ${assets.length} Bild(ern) erkannt.`);
  }

  async function startEdupageImageImport() {
    if (!requireEditMode()) {
      return;
    }

    if (Platform.OS === 'web') {
      setMessage('Edupage-Bildimport mit OCR ist nur in der iOS-/Android-App verfügbar.');
      return;
    }

    if (edupageImportBusy || selectionActive) {
      return;
    }

    setEdupageImportBusy(true);
    setMessage('Kamera wird geöffnet...');

    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();

      if (!permission.granted) {
        setMessage('Kein Zugriff auf die Kamera. Bitte Berechtigung erlauben.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: false,
        exif: false,
        mediaTypes: ['images'],
        quality: 1,
      });

      if (result.canceled) {
        setMessage('Edupage-Foto abgebrochen.');
        return;
      }

      setMessage('Edupage-Foto wird gelesen...');
      await openEdupageImportReview(result.assets);
    } catch {
      setMessage('Edupage-Bildimport konnte nicht ausgeführt werden.');
    } finally {
      setEdupageImportBusy(false);
    }
  }

  async function startEdupageGalleryImport() {
    if (!requireEditMode()) {
      return;
    }

    if (Platform.OS === 'web') {
      setMessage('Edupage-Bildimport mit OCR ist nur in der iOS-/Android-App verfügbar.');
      return;
    }

    if (edupageImportBusy || selectionActive) {
      return;
    }

    setEdupageImportBusy(true);
    setMessage('Edupage-Bilder werden gelesen...');

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        setMessage('Kein Zugriff auf Fotos. Bitte Berechtigung erlauben.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsMultipleSelection: true,
        exif: false,
        mediaTypes: ['images'],
        quality: 1,
        selectionLimit: 0,
      });

      if (result.canceled) {
        setMessage('Edupage-Import abgebrochen.');
        return;
      }

      await openEdupageImportReview(result.assets);
    } catch {
      setMessage('Edupage-Galerieimport konnte nicht ausgeführt werden.');
    } finally {
      setEdupageImportBusy(false);
    }
  }

  function updateEdupageDraftStudent(
    id: string,
    updater: (student: EdupageImportStudentDraft) => EdupageImportStudentDraft,
  ) {
    if (!editMode) {
      return;
    }

    setEdupageDraft((currentDraft) => {
      if (!currentDraft) {
        return currentDraft;
      }

      return {
        ...currentDraft,
        students: currentDraft.students.map((student) => (student.id === id ? updater(student) : student)),
      };
    });
  }

  function confirmEdupageImport() {
    if (!requireEditMode()) {
      return;
    }

    if (!edupageDraft) {
      return;
    }

    const courseName = edupageDraft.courseName.trim() || 'Edupage-Kurs';
    const selectedStudents = edupageDraft.students
      .filter((student) => student.selected && student.name.trim())
      .map((student) => ({ ...student, name: normalizeText(student.name) }));

    if (selectedStudents.length === 0) {
      setMessage('Keine Schüler für den Edupage-Import ausgewählt.');
      return;
    }

    const existingCourse = courses.find((course) => normalizeLookupKey(course.name) === normalizeLookupKey(courseName));
    const targetCourseId = existingCourse?.id ?? createId();

    if (existingCourse) {
      setCourses((currentCourses) =>
        currentCourses.map((course) => {
          if (course.id !== existingCourse.id) {
            return course;
          }

          const importedByName = new Map(selectedStudents.map((student) => [normalizeLookupKey(student.name), student]));
          const existingNames = new Set(course.students.map((student) => normalizeLookupKey(student.name)));
          const updatedStudents = course.students.map((student) => {
            const importedStudent = importedByName.get(normalizeLookupKey(student.name));

            if (!importedStudent) {
              return student;
            }

            return {
              ...student,
              name: importedStudent.name,
              imageUri: importedStudent.imageUri ?? student.imageUri,
            };
          });
          const newStudents = selectedStudents
            .filter((student) => !existingNames.has(normalizeLookupKey(student.name)))
            .map((student) => ({
              ...createStudent(student.name),
              imageUri: student.imageUri,
            }));

          return {
            ...course,
            name: courseName,
            students: [...updatedStudents, ...newStudents],
          };
        }),
      );
    } else {
      setCourses((currentCourses) => [
        ...currentCourses,
        {
          id: targetCourseId,
          name: courseName,
          selectedId: null,
          students: selectedStudents.map((student) => ({
            ...createStudent(student.name),
            imageUri: student.imageUri,
          })),
        },
      ]);
    }

    setActiveCourseId(targetCourseId);
    setCurrentView('students');
    setEdupageDraft(null);
    setMessage(`${selectedStudents.length} Schüler in ${courseName} übernommen.`);
  }

  function removeStudent(id: string) {
    if (!requireEditMode()) {
      return;
    }

    const removed = students.find((student) => student.id === id);

    setStudents((currentStudents) => currentStudents.filter((student) => student.id !== id));

    if (selectedId === id) {
      setSelectedId(null);
    }

    if (removed) {
      setMessage(`${removed.name} entfernt.`);
    }
  }

  function resetCounts() {
    if (!requireEditMode()) {
      return;
    }

    setStudents((currentStudents) => currentStudents.map((student) => ({ ...student, count: 0 })));
    setSelectedId(null);
    setMessage('Alle Zähler sind zurückgesetzt.');
  }

  async function openStudentImageEditor(student: Student) {
    if (!requireEditMode()) {
      return;
    }

    const sourceUri = resolveStoredImageUri(student.imageUri);
    const baseEditorState = {
      brightness: student.imageBrightness ?? 0,
      offsetX: 0,
      offsetY: 0,
      studentId: student.id,
      studentName: student.name,
      zoom: 1,
    };

    if (!sourceUri) {
      setImageEditor({
        ...baseEditorState,
        sourceHeight: 0,
        sourceUri: '',
        sourceWidth: 0,
      });
      return;
    }

    try {
      const size = await getImageSize(sourceUri);

      setImageEditor({
        ...baseEditorState,
        sourceHeight: size.height,
        sourceUri,
        sourceWidth: size.width,
      });
    } catch {
      setImageEditor({
        ...baseEditorState,
        sourceHeight: 0,
        sourceUri: '',
        sourceWidth: 0,
      });
      setMessage('Bild konnte nicht geladen werden. Bitte neu auswählen.');
    }
  }

  function updateImageEditor(updater: (currentEditor: ImageEditorState) => ImageEditorState) {
    setImageEditor((currentEditor) => (currentEditor ? updater(currentEditor) : currentEditor));
  }

  async function chooseImageEditorSource(source: 'camera' | 'library') {
    if (!imageEditor || imageEditorBusy) {
      return;
    }

    setImageEditorBusy(true);

    try {
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();

        if (!permission.granted) {
          setMessage('Kein Zugriff auf die Kamera. Bitte Berechtigung erlauben.');
          return;
        }
      } else {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

        if (!permission.granted) {
          setMessage('Kein Zugriff auf Fotos. Bitte Berechtigung erlauben.');
          return;
        }
      }

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({
              allowsEditing: false,
              exif: false,
              mediaTypes: ['images'],
              quality: 1,
            })
          : await ImagePicker.launchImageLibraryAsync({
              allowsEditing: false,
              exif: false,
              mediaTypes: ['images'],
              quality: 1,
            });

      if (result.canceled) {
        return;
      }

      const asset = result.assets[0];

      setImageEditor((currentEditor) =>
        currentEditor
          ? {
              ...currentEditor,
              offsetX: 0,
              offsetY: 0,
              sourceHeight: asset.height,
              sourceUri: asset.uri,
              sourceWidth: asset.width,
              zoom: 1,
            }
          : currentEditor,
      );
    } catch {
      setMessage('Bild konnte nicht ausgewählt werden.');
    } finally {
      setImageEditorBusy(false);
    }
  }

  function createManualImageCrop(editor: ImageEditorState): PhotoCrop | null {
    if (editor.sourceWidth <= 0 || editor.sourceHeight <= 0) {
      return null;
    }

    const cropSize = Math.max(1, Math.round(Math.min(editor.sourceWidth, editor.sourceHeight) / editor.zoom));
    const maxOriginX = Math.max(0, editor.sourceWidth - cropSize);
    const maxOriginY = Math.max(0, editor.sourceHeight - cropSize);
    const originX = clamp(Math.round(maxOriginX / 2 + (editor.offsetX / 100) * (maxOriginX / 2)), 0, maxOriginX);
    const originY = clamp(Math.round(maxOriginY / 2 + (editor.offsetY / 100) * (maxOriginY / 2)), 0, maxOriginY);

    return {
      height: cropSize,
      originX,
      originY,
      width: cropSize,
    };
  }

  async function saveStudentImageEditor() {
    if (!imageEditor || imageEditorBusy) {
      return;
    }

    setImageEditorBusy(true);

    try {
      if (!imageEditor.sourceUri) {
        updateStudent(imageEditor.studentId, (student) => ({
          ...student,
          imageBrightness: imageEditor.brightness,
        }));
        setImageEditor(null);
        setMessage(`Bildanpassung für ${imageEditor.studentName} gespeichert.`);
        return;
      }

      const crop = createManualImageCrop(imageEditor);

      if (!crop) {
        setMessage('Kein Bild zum Speichern ausgewählt.');
        return;
      }

      const editedImage = await ImageManipulator.manipulateAsync(
        imageEditor.sourceUri,
        [{ crop }, { resize: { height: 320, width: 320 } }],
        { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
      );
      const storedImageUri = await persistStudentImage(editedImage.uri);

      updateStudent(imageEditor.studentId, (student) => ({
        ...student,
        imageBrightness: imageEditor.brightness,
        imageUri: storedImageUri,
      }));
      setImageEditor(null);
      setMessage(`Bild für ${imageEditor.studentName} gespeichert.`);
    } catch {
      setMessage('Bild konnte nicht gespeichert werden.');
    } finally {
      setImageEditorBusy(false);
    }
  }

  function removeStudentImage() {
    if (!imageEditor) {
      return;
    }

    const editorStudent = imageEditor;

    confirmDestructiveAction('Bild entfernen', `Bild von ${editorStudent.studentName} entfernen?`, () => {
      updateStudent(editorStudent.studentId, (student) => {
        const nextStudent = { ...student };
        delete nextStudent.imageUri;
        delete nextStudent.imageBrightness;
        return nextStudent;
      });
      setImageEditor(null);
      setMessage(`Bild von ${editorStudent.studentName} entfernt.`);
    });
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <Modal
        animationType="slide"
        onRequestClose={closeSelectionOverlay}
        presentationStyle="fullScreen"
        visible={selectionOverlayVisible}
      >
        <SafeAreaView style={styles.selectionModal}>
          <View style={styles.selectionModalHeader}>
            <View style={styles.selectionModalTitleBlock}>
              <Text style={styles.selectionModalKicker}>{activeCourse?.name ?? 'Kurs'}</Text>
              <Text style={styles.selectionModalTitle}>Auswahl</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={closeSelectionOverlay}
              style={({ pressed }) => [styles.modalCloseButton, pressed && styles.pressed]}
            >
              <Text style={styles.modalCloseButtonText}>
                {selectionActive ? 'Abbrechen' : 'Fertig'}
              </Text>
            </Pressable>
          </View>

          <View style={[styles.selectionModalBody, compactSelectionLayout && styles.selectionModalBodyCompact]}>
            <View style={styles.selectionHero}>
              <View style={[styles.selectionStage, compactSelectionLayout && styles.selectionStageCompact]}>
                <Text style={[styles.selectionStageLabel, compactSelectionLayout && styles.selectionStageLabelCompact]}>
                  {selectionPhase === 'confirming'
                    ? 'Kandidat'
                    : selectionPhase === 'rolling'
                      ? 'Auswahl läuft'
                      : 'Heute dran'}
                </Text>
                <Animated.View
                  style={[
                    styles.selectionPulseRing,
                    compactSelectionLayout && styles.selectionPulseRingCompact,
                    selectionPulseToneStyle,
                    selectionPulseStyle,
                  ]}
                />
                <Animated.View
                  style={[
                    styles.selectionSweep,
                    compactSelectionLayout && styles.selectionSweepCompact,
                    selectionSweepStyle,
                  ]}
                />
                <Animated.View
                  style={[
                    styles.selectionHeroCard,
                    styles.selectionHeroCardLowered,
                    compactSelectionLayout && styles.selectionHeroCardLoweredCompact,
                    selectionRevealStyle,
                  ]}
                >
                  <StudentImageView
                    imageStyle={[
                      styles.selectionHeroImage,
                      compactSelectionLayout && styles.selectionHeroImageCompact,
                    ]}
                    placeholderStyle={[
                      styles.selectionHeroPlaceholder,
                      compactSelectionLayout && styles.selectionHeroPlaceholderCompact,
                    ]}
                    placeholderTextStyle={[
                      styles.selectionHeroPlaceholderText,
                      compactSelectionLayout && styles.selectionHeroPlaceholderTextCompact,
                    ]}
                    student={displayedStudent}
                  />
                  <Text
                    adjustsFontSizeToFit
                    numberOfLines={2}
                    style={[styles.selectionHeroName, compactSelectionLayout && styles.selectionHeroNameCompact]}
                  >
                    {displayedName}
                  </Text>
                  <Text style={[styles.selectionHeroMeta, compactSelectionLayout && styles.selectionHeroMetaCompact]}>
                    {displayedMeta}
                  </Text>
                </Animated.View>
              </View>
              <View style={[styles.selectionSuspenseBar, compactSelectionLayout && styles.selectionSuspenseBarCompact]}>
                <Text style={styles.selectionSuspenseText}>{selectionStageText}</Text>
                <View style={styles.selectionDotRow}>
                  <View style={styles.selectionDot} />
                  <View style={[styles.selectionDot, styles.selectionDotActive]} />
                  <View style={styles.selectionDot} />
                </View>
              </View>
            </View>

            {selectionActive && skippedCandidateCount > 0 && (
              <View style={[styles.modalStatusPanel, compactSelectionLayout && styles.modalStatusPanelCompact]}>
                <View style={styles.skippedPanelHeader}>
                  <Text style={styles.statusLabel}>Kurz angezeigt</Text>
                  <Text style={[styles.statusMeta, compactSelectionLayout && styles.statusMetaCompact]}>
                    {skippedCandidateCount} übersprungen
                  </Text>
                </View>
                <ScrollView
                  nestedScrollEnabled
                  style={[styles.skippedScrollArea, compactSelectionLayout && styles.skippedScrollAreaCompact]}
                >
                  <View style={styles.skippedList}>
                    {skippedCandidates.map((candidate) => (
                      <View
                        key={candidate.key}
                        style={styles.skippedPill}
                      >
                        <Text
                          numberOfLines={1}
                          style={styles.skippedName}
                        >
                          {candidate.name}
                        </Text>
                        <Text style={styles.skippedCount}>{candidate.remainingBefore}</Text>
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </View>
            )}

            {selectionPhase === 'confirming' && pendingCandidate && (
              <View style={[styles.modalPresencePrompt, compactSelectionLayout && styles.modalPresencePromptCompact]}>
                <Text
                  numberOfLines={2}
                  style={[styles.modalPresenceTitle, compactSelectionLayout && styles.modalPresenceTitleCompact]}
                >
                  Ist {pendingCandidate.name} anwesend?
                </Text>
                <View style={styles.modalPromptActions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => answerPresence(false)}
                    style={({ pressed }) => [styles.noButton, styles.modalAnswerButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.noButtonText}>Nein</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => answerPresence(true)}
                    style={({ pressed }) => [styles.yesButton, styles.modalAnswerButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.yesButtonText}>Ja</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </View>
          {celebrationActive && (
            <View
              pointerEvents="none"
              style={styles.fireworksLayer}
            >
              {fireworkBursts.map((burst) => renderFireworkRocket(burst))}
              {fireworkBursts.flatMap((burst) =>
                FIREWORK_PARTICLE_DIRECTIONS.map((direction, particleIndex) =>
                  renderFireworkParticle(burst, direction, particleIndex),
                ),
              )}
            </View>
          )}
        </SafeAreaView>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => setImageEditor(null)}
        presentationStyle="pageSheet"
        visible={Boolean(imageEditor)}
      >
        <SafeAreaView style={styles.imageEditorModal}>
          <View style={styles.imageEditorHeader}>
            <View style={styles.imageEditorTitleBlock}>
              <Text style={styles.kicker}>Bild bearbeiten</Text>
              <Text
                numberOfLines={1}
                style={styles.imageEditorTitle}
              >
                {imageEditor?.studentName ?? 'Schüler'}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={imageEditorBusy}
              onPress={() => setImageEditor(null)}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.pressed,
                imageEditorBusy && styles.disabledButton,
              ]}
            >
              <Text style={styles.secondaryButtonText}>Schließen</Text>
            </Pressable>
          </View>

          {imageEditor && (
            <ScrollView
              contentContainerStyle={styles.imageEditorBody}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.imageEditorPreview}>
                {imageEditor.sourceUri ? (
                  <>
                    <Image
                      resizeMode="cover"
                      source={{ uri: imageEditor.sourceUri }}
                      style={[
                        styles.imageEditorPreviewImage,
                        {
                          transform: [
                            { scale: imageEditor.zoom },
                            { translateX: -imageEditor.offsetX * 0.6 },
                            { translateY: -imageEditor.offsetY * 0.6 },
                          ],
                        },
                      ]}
                    />
                    {imageEditor.brightness !== 0 && (
                      <View
                        pointerEvents="none"
                        style={[
                          styles.imageBrightnessOverlay,
                          {
                            backgroundColor: imageEditor.brightness > 0 ? '#FFFFFF' : '#000000',
                            opacity: Math.abs(imageEditor.brightness),
                          },
                        ]}
                      />
                    )}
                  </>
                ) : (
                  <View style={styles.imageEditorEmptyPreview}>
                    <Text style={styles.studentImagePlaceholderText}>?</Text>
                  </View>
                )}
              </View>

              <View style={styles.imageEditorActions}>
                <Pressable
                  accessibilityRole="button"
                  disabled={imageEditorBusy}
                  onPress={() => chooseImageEditorSource('camera')}
                  style={({ pressed }) => [
                    styles.importButton,
                    pressed && styles.pressed,
                    imageEditorBusy && styles.disabledButton,
                  ]}
                >
                  <Text style={styles.importButtonText}>Kamera</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={imageEditorBusy}
                  onPress={() => chooseImageEditorSource('library')}
                  style={({ pressed }) => [
                    styles.fileImportButton,
                    pressed && styles.pressed,
                    imageEditorBusy && styles.disabledButton,
                  ]}
                >
                  <Text style={styles.fileImportButtonText}>Galerie</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={imageEditorBusy}
                  onPress={removeStudentImage}
                  style={({ pressed }) => [
                    styles.warningButton,
                    pressed && styles.pressed,
                    imageEditorBusy && styles.disabledButton,
                  ]}
                >
                  <Text style={styles.warningButtonText}>Bild entfernen</Text>
                </Pressable>
              </View>

              <View style={styles.editorControlPanel}>
                <Text style={styles.panelTitle}>Zuschnitt</Text>
                <View style={styles.editorStepperRow}>
                  <Text style={styles.editorStepperLabel}>Zoom</Text>
                  <View style={styles.editorStepperButtons}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        updateImageEditor((editor) => ({
                          ...editor,
                          zoom: clamp(Number((editor.zoom - 0.15).toFixed(2)), 1, 3),
                        }))
                      }
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.iconButtonText}>-</Text>
                    </Pressable>
                    <Text style={styles.editorValueText}>{Math.round(imageEditor.zoom * 100)} %</Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        updateImageEditor((editor) => ({
                          ...editor,
                          zoom: clamp(Number((editor.zoom + 0.15).toFixed(2)), 1, 3),
                        }))
                      }
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.iconButtonText}>+</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.editorStepperRow}>
                  <Text style={styles.editorStepperLabel}>Horizontal</Text>
                  <View style={styles.editorStepperButtons}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        updateImageEditor((editor) => ({
                          ...editor,
                          offsetX: clamp(editor.offsetX - 12, -100, 100),
                        }))
                      }
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.iconButtonText}>-</Text>
                    </Pressable>
                    <Text style={styles.editorValueText}>{imageEditor.offsetX}</Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        updateImageEditor((editor) => ({
                          ...editor,
                          offsetX: clamp(editor.offsetX + 12, -100, 100),
                        }))
                      }
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.iconButtonText}>+</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.editorStepperRow}>
                  <Text style={styles.editorStepperLabel}>Vertikal</Text>
                  <View style={styles.editorStepperButtons}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        updateImageEditor((editor) => ({
                          ...editor,
                          offsetY: clamp(editor.offsetY - 12, -100, 100),
                        }))
                      }
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.iconButtonText}>-</Text>
                    </Pressable>
                    <Text style={styles.editorValueText}>{imageEditor.offsetY}</Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        updateImageEditor((editor) => ({
                          ...editor,
                          offsetY: clamp(editor.offsetY + 12, -100, 100),
                        }))
                      }
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.iconButtonText}>+</Text>
                    </Pressable>
                  </View>
                </View>
              </View>

              <View style={styles.editorControlPanel}>
                <Text style={styles.panelTitle}>Helligkeit</Text>
                <View style={styles.editorStepperRow}>
                  <Text style={styles.editorStepperLabel}>
                    {imageEditor.brightness > 0
                      ? 'Heller'
                      : imageEditor.brightness < 0
                        ? 'Dunkler'
                        : 'Normal'}
                  </Text>
                  <View style={styles.editorStepperButtons}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        updateImageEditor((editor) => ({
                          ...editor,
                          brightness: clamp(Number((editor.brightness - 0.08).toFixed(2)), -0.45, 0.45),
                        }))
                      }
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.iconButtonText}>-</Text>
                    </Pressable>
                    <Text style={styles.editorValueText}>{Math.round(imageEditor.brightness * 100)} %</Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        updateImageEditor((editor) => ({
                          ...editor,
                          brightness: clamp(Number((editor.brightness + 0.08).toFixed(2)), -0.45, 0.45),
                        }))
                      }
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.iconButtonText}>+</Text>
                    </Pressable>
                  </View>
                </View>
              </View>

              <View style={styles.draftActions}>
                <Pressable
                  accessibilityRole="button"
                  disabled={imageEditorBusy}
                  onPress={() => setImageEditor(null)}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.pressed,
                    imageEditorBusy && styles.disabledButton,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>Abbrechen</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={imageEditorBusy}
                  onPress={saveStudentImageEditor}
                  style={({ pressed }) => [
                    styles.importButton,
                    pressed && styles.pressed,
                    imageEditorBusy && styles.disabledButton,
                  ]}
                >
                  <Text style={styles.importButtonText}>
                    {imageEditorBusy ? 'Speichert...' : 'Speichern'}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      <Modal
        animationType="slide"
        onRequestClose={() => setInfoVisible(false)}
        presentationStyle="pageSheet"
        visible={infoVisible}
      >
        <SafeAreaView style={styles.infoModal}>
          <View style={styles.infoHeader}>
            <View style={styles.infoTitleBlock}>
              <Text style={styles.kicker}>Info</Text>
              <Text style={styles.infoTitle}>Was macht die App?</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => setInfoVisible(false)}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryButtonText}>Schließen</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.infoBody}>
            <View style={styles.infoPanel}>
              <Text style={styles.infoSectionTitle}>Zweck</Text>
              <Text style={styles.infoText}>
                Die App hilft dabei, Kurse zu verwalten und Schüler für mündliche Abfragen fair auszuwählen. Sie
                speichert pro Schüler, wie oft er bereits ausgewählt wurde, und zeigt daraus die aktuelle Chance für
                die nächste Auswahl.
              </Text>
            </View>

            <View style={styles.infoPanel}>
              <Text style={styles.infoSectionTitle}>Auswahlalgorithmus</Text>
              <Text style={styles.infoText}>
                Die Auswahl folgt deiner ursprünglichen Python-Idee: Die App zieht zufällig einen Namen. Hat dieser
                Schüler bereits einen Zähler größer als 0, wird er kurz angezeigt, aber für diesen Zug übersprungen;
                sein temporärer Zähler wird nur innerhalb dieses Auswahlprozesses um 1 reduziert. Erst wenn ein
                gezogener Schüler temporär bei 0 steht, fragt die App, ob er anwesend ist.
              </Text>
              <Text style={styles.infoText}>
                Ist der Schüler anwesend, wird er ausgewählt und sein dauerhafter Zähler steigt um 1. Ist er nicht
                anwesend, wird er nur für diese eine Auswahlrunde herausgenommen. Nach der Runde sind alle wieder
                normale Kandidaten.
              </Text>
            </View>

            <View style={styles.infoPanel}>
              <Text style={styles.infoSectionTitle}>Wahrscheinlichkeiten</Text>
              <Text style={styles.infoText}>
                Die Prozentwerte verwenden dasselbe Modell wie die Auswahl. Schüler mit niedrigeren Zählern haben
                eine höhere Chance, aber die Reihenfolge bleibt zufällig.
              </Text>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.page}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.shell}>
            <View style={[styles.header, compactLayout && styles.headerCompact]}>
              <View style={styles.headerTitleBlock}>
                <Text style={styles.kicker}>{currentView === 'courses' ? 'Kurse' : 'Klassenliste'}</Text>
                <Text style={[styles.title, compactLayout && styles.titleCompact]}>Mündliche Abfrage</Text>
              </View>
              <View style={[styles.summary, compactLayout && styles.summaryCompact]}>
                <Text style={styles.summaryNumber}>{currentView === 'courses' ? courses.length : students.length}</Text>
                <Text style={styles.summaryLabel}>{currentView === 'courses' ? 'Kurse' : 'Schüler'}</Text>
              </View>
            </View>

            <View style={styles.editModePanel}>
              <View style={styles.editModeTextBlock}>
                <Text style={styles.panelTitle}>Bearbeitungsmodus</Text>
                <Text style={styles.editModeMeta}>{editMode ? 'Änderungen erlaubt' : 'Liste geschützt'}</Text>
              </View>
              <Switch
                disabled={selectionActive}
                onValueChange={setEditMode}
                thumbColor="#FFFFFF"
                trackColor={{ false: '#C8CDC8', true: '#2F7D63' }}
                value={editMode}
              />
            </View>

            {currentView === 'courses' || !activeCourse ? (
              <>
                <View style={styles.homeHeader}>
                  <View>
                    <Text style={styles.panelTitle}>Klassen und Kurse</Text>
                    <Text style={styles.homeMeta}>
                      {courses.length} Kurse · {totalStudentCount} Schüler
                    </Text>
                  </View>
                  <View style={styles.homeHeaderActions}>
                    <Pressable
                      accessibilityLabel="Info zur App"
                      accessibilityRole="button"
                      onPress={() => setInfoVisible(true)}
                      style={({ pressed }) => [styles.infoButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.infoButtonText}>i</Text>
                    </Pressable>
                    <Text style={styles.message}>{hydrated ? message : 'Lade Daten...'}</Text>
                  </View>
                </View>

                <View style={styles.courseGrid}>
                  {courses.length === 0 ? (
                    <View style={styles.emptyState}>
                      <Text style={styles.emptyStateTitle}>Noch keine Kurse</Text>
                      <Text style={styles.emptyStateText}>
                        Bearbeitungsmodus einschalten und Kurs anlegen oder Edupage-Bild importieren.
                      </Text>
                    </View>
                  ) : (
                    courses.map((course) => (
                      <Pressable
                        accessibilityRole="button"
                        disabled={selectionActive}
                        key={course.id}
                        onPress={() => selectCourse(course.id)}
                        style={({ pressed }) => [
                          styles.courseCard,
                          course.id === activeCourseId && styles.activeCourseCard,
                          pressed && styles.pressed,
                          selectionActive && styles.disabledButton,
                        ]}
                      >
                        <Text
                          numberOfLines={2}
                          style={styles.courseCardTitle}
                        >
                          {course.name}
                        </Text>
                        <Text style={styles.courseCardMeta}>{course.students.length} Schüler</Text>
                      </Pressable>
                    ))
                  )}
                </View>

                {editMode && (
                  <View style={styles.inputGrid}>
                    <View style={styles.inputPanel}>
                      <Text style={styles.panelTitle}>Kurs hinzufügen</Text>
                      <View style={styles.inlineForm}>
                        <TextInput
                          autoCapitalize="words"
                          editable={!editControlsDisabled}
                          onChangeText={setNewCourseName}
                          onSubmitEditing={addCourse}
                          placeholder="Neuer Kurs"
                          placeholderTextColor="#7B807C"
                          returnKeyType="done"
                          style={[styles.textInput, editControlsDisabled && styles.disabledInput]}
                          value={newCourseName}
                        />
                        <Pressable
                          accessibilityRole="button"
                          disabled={editControlsDisabled}
                          onPress={addCourse}
                          style={({ pressed }) => [
                            styles.addButton,
                            pressed && styles.pressed,
                            editControlsDisabled && styles.disabledButton,
                          ]}
                        >
                          <Text style={styles.addButtonText}>+</Text>
                        </Pressable>
                      </View>
                    </View>

                    <View style={styles.inputPanel}>
                      <Text style={styles.panelTitle}>Edupage importieren</Text>
                      <View style={styles.importActions}>
                        <Pressable
                          accessibilityRole="button"
                          disabled={importDisabled}
                          onPress={startEdupageImageImport}
                          style={({ pressed }) => [
                            styles.importButton,
                            pressed && styles.pressed,
                            importDisabled && styles.disabledButton,
                          ]}
                        >
                          <Text style={styles.importButtonText}>
                            {edupageImportBusy ? 'Lese...' : 'Edupage-Bild'}
                          </Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          disabled={importDisabled}
                          onPress={startEdupageGalleryImport}
                          style={({ pressed }) => [
                            styles.fileImportButton,
                            pressed && styles.pressed,
                            importDisabled && styles.disabledButton,
                          ]}
                        >
                          <Text style={styles.fileImportButtonText}>Galerie</Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                )}
              </>
            ) : (
              <>
                <View style={styles.detailHeader}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={selectionActive}
                    onPress={showCourseOverview}
                    style={({ pressed }) => [
                      styles.backButton,
                      pressed && styles.pressed,
                      selectionActive && styles.disabledButton,
                    ]}
                  >
                    <Text style={styles.backButtonText}>Zurück</Text>
                  </Pressable>
                  <View style={styles.detailTitleBlock}>
                    <Text
                      numberOfLines={1}
                      style={styles.detailTitle}
                    >
                      {activeCourse.name}
                    </Text>
                    <Text style={styles.detailMeta}>
                      {students.length} Schüler
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    disabled={presentStudents.length === 0 || selectionActive}
                    onPress={startSelection}
                    style={({ pressed }) => [
                      styles.primaryButton,
                      styles.detailSelectButton,
                      pressed && styles.pressed,
                      (presentStudents.length === 0 || selectionActive) && styles.disabledButton,
                    ]}
                  >
                    <Text style={styles.primaryButtonText}>Auswählen</Text>
                  </Pressable>
                </View>

                {editMode && (
                  <>
                    <View style={styles.selectionTimingPanel}>
                      <View style={styles.selectionTimingCopy}>
                        <Text style={styles.selectionTimingTitle}>Auswahlzeit</Text>
                        <Text style={styles.selectionTimingMeta}>
                          Rot pulsiert {selectionRevealDelayLabel}, dann wird geprüft oder entschieden.
                        </Text>
                      </View>
                      <View style={styles.selectionTimingControls}>
                        <Pressable
                          accessibilityRole="button"
                          disabled={selectionActive || selectionRevealDelayMs <= MIN_SELECTION_REVEAL_DELAY_MS}
                          onPress={() => changeSelectionRevealDelay(-SELECTION_REVEAL_DELAY_STEP_MS)}
                          style={({ pressed }) => [
                            styles.timingStepButton,
                            pressed && styles.pressed,
                            (selectionActive || selectionRevealDelayMs <= MIN_SELECTION_REVEAL_DELAY_MS) &&
                              styles.disabledButton,
                          ]}
                        >
                          <Text style={styles.timingStepButtonText}>-</Text>
                        </Pressable>
                        <View style={styles.timingValuePill}>
                          <Text style={styles.timingValueText}>{selectionRevealDelayLabel}</Text>
                        </View>
                        <Pressable
                          accessibilityRole="button"
                          disabled={selectionActive || selectionRevealDelayMs >= MAX_SELECTION_REVEAL_DELAY_MS}
                          onPress={() => changeSelectionRevealDelay(SELECTION_REVEAL_DELAY_STEP_MS)}
                          style={({ pressed }) => [
                            styles.timingStepButton,
                            pressed && styles.pressed,
                            (selectionActive || selectionRevealDelayMs >= MAX_SELECTION_REVEAL_DELAY_MS) &&
                              styles.disabledButton,
                          ]}
                        >
                          <Text style={styles.timingStepButtonText}>+</Text>
                        </Pressable>
                      </View>
                    </View>

                    <View style={styles.coursePanel}>
                      <View style={styles.courseHeader}>
                        <Text style={styles.panelTitle}>Kurs bearbeiten</Text>
                        <Text style={styles.courseMeta}>{students.length} Schüler</Text>
                      </View>
                      <View style={styles.courseForms}>
                        <TextInput
                          autoCapitalize="words"
                          editable={!editControlsDisabled && Boolean(activeCourse)}
                          onChangeText={renameActiveCourse}
                          placeholder="Aktiver Kurs"
                          placeholderTextColor="#7B807C"
                          style={[
                            styles.textInput,
                            styles.courseNameInput,
                            editControlsDisabled && styles.disabledInput,
                          ]}
                          value={activeCourse.name}
                        />
                        <Pressable
                          accessibilityRole="button"
                          disabled={editControlsDisabled || !activeCourse}
                          onPress={deleteActiveCourse}
                          style={({ pressed }) => [
                            styles.warningButton,
                            pressed && styles.pressed,
                            (editControlsDisabled || !activeCourse) && styles.disabledButton,
                          ]}
                        >
                          <Text style={styles.warningButtonText}>Kurs löschen</Text>
                        </Pressable>
                      </View>
                    </View>

                    <View style={styles.toolbar}>
                      <Pressable
                        accessibilityRole="button"
                        disabled={editControlsDisabled}
                        onPress={resetCounts}
                        style={({ pressed }) => [
                          styles.warningButton,
                          pressed && styles.pressed,
                          editControlsDisabled && styles.disabledButton,
                        ]}
                      >
                        <Text style={styles.warningButtonText}>Zähler zurücksetzen</Text>
                      </Pressable>
                    </View>

                    <View style={styles.inputGrid}>
                      <View style={styles.inputPanel}>
                        <Text style={styles.panelTitle}>Schüler hinzufügen</Text>
                        <View style={styles.inlineForm}>
                          <TextInput
                            autoCapitalize="words"
                            editable={!editControlsDisabled}
                            onChangeText={setNewName}
                            onSubmitEditing={addStudent}
                            placeholder="Name"
                            placeholderTextColor="#7B807C"
                            returnKeyType="done"
                            style={[styles.textInput, editControlsDisabled && styles.disabledInput]}
                            value={newName}
                          />
                          <Pressable
                            accessibilityRole="button"
                            disabled={editControlsDisabled}
                            onPress={addStudent}
                            style={({ pressed }) => [
                              styles.addButton,
                              pressed && styles.pressed,
                              editControlsDisabled && styles.disabledButton,
                            ]}
                          >
                            <Text style={styles.addButtonText}>+</Text>
                          </Pressable>
                        </View>
                      </View>

                      <View style={styles.inputPanel}>
                        <Text style={styles.panelTitle}>Liste importieren</Text>
                        <TextInput
                          editable={!editControlsDisabled}
                          multiline
                          onChangeText={setImportText}
                          placeholder="Namen mit Komma oder Zeilenumbruch"
                          placeholderTextColor="#7B807C"
                          style={[styles.textInput, styles.importInput, editControlsDisabled && styles.disabledInput]}
                          textAlignVertical="top"
                          value={importText}
                        />
                        <View style={styles.importActions}>
                          <Pressable
                            accessibilityRole="button"
                            disabled={importDisabled}
                            onPress={importStudents}
                            style={({ pressed }) => [
                              styles.importButton,
                              pressed && styles.pressed,
                              importDisabled && styles.disabledButton,
                            ]}
                          >
                            <Text style={styles.importButtonText}>Importieren</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={importDisabled}
                            onPress={importStudentsFromCsvFile}
                            style={({ pressed }) => [
                              styles.fileImportButton,
                              pressed && styles.pressed,
                              importDisabled && styles.disabledButton,
                            ]}
                          >
                            <Text style={styles.fileImportButtonText}>CSV-Datei</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={importDisabled}
                            onPress={startEdupageImageImport}
                            style={({ pressed }) => [
                              styles.fileImportButton,
                              pressed && styles.pressed,
                              importDisabled && styles.disabledButton,
                            ]}
                          >
                            <Text style={styles.fileImportButtonText}>
                              {edupageImportBusy ? 'Lese...' : 'Edupage-Bild'}
                            </Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={importDisabled}
                            onPress={startEdupageGalleryImport}
                            style={({ pressed }) => [
                              styles.fileImportButton,
                              pressed && styles.pressed,
                              importDisabled && styles.disabledButton,
                            ]}
                          >
                            <Text style={styles.fileImportButtonText}>Galerie</Text>
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  </>
                )}
              </>
            )}

            {edupageDraft && (
              <View style={styles.edupageDraftPanel}>
                <View style={styles.edupageDraftHeader}>
                  <View style={styles.edupageDraftTitleBlock}>
                    <Text style={styles.panelTitle}>Edupage-Import prüfen</Text>
                    <Text style={styles.draftMeta}>
                      {selectedDraftStudentCount}/{edupageDraft.students.length} Schüler aus{' '}
                      {edupageDraft.sourceImageCount} Bild(ern)
                    </Text>
                  </View>
                  <TextInput
                    autoCapitalize="words"
                    editable={!editControlsDisabled}
                    onChangeText={(courseName) =>
                      setEdupageDraft((currentDraft) =>
                        currentDraft ? { ...currentDraft, courseName } : currentDraft,
                      )
                    }
                    placeholder="Kursname"
                    placeholderTextColor="#7B807C"
                    style={[styles.textInput, styles.draftCourseInput, editControlsDisabled && styles.disabledInput]}
                    value={edupageDraft.courseName}
                  />
                </View>

                {edupageDraft.warnings.length > 0 && (
                  <View style={styles.warningStrip}>
                    <Text style={styles.warningStripText}>{edupageDraft.warnings.join(' · ')}</Text>
                  </View>
                )}

                <View style={styles.draftStudentList}>
                  {edupageDraft.students.length === 0 ? (
                    <Text style={styles.emptyStateText}>Keine Schüler erkannt. Versuche einen klareren Screenshot.</Text>
                  ) : (
                    edupageDraft.students.map((student) => (
                      <View
                        key={student.id}
                        style={styles.draftStudentRow}
                      >
                        <StudentImageView
                          imageStyle={styles.studentImage}
                          placeholderStyle={styles.studentImagePlaceholder}
                          placeholderTextStyle={styles.studentImagePlaceholderText}
                          student={student}
                        />
                        <View style={styles.draftStudentMain}>
                          <TextInput
                            autoCapitalize="words"
                            editable={!editControlsDisabled && student.selected}
                            onChangeText={(name) =>
                              updateEdupageDraftStudent(student.id, (current) => ({
                                ...current,
                                name,
                              }))
                            }
                            style={[
                              styles.nameInput,
                              styles.draftNameInput,
                              (!student.selected || editControlsDisabled) && styles.disabledNameInput,
                            ]}
                            value={student.name}
                          />
                          {student.warnings.length > 0 && (
                            <Text style={styles.draftWarningText}>{student.warnings.join(' · ')}</Text>
                          )}
                        </View>
                        <Switch
                          disabled={editControlsDisabled}
                          onValueChange={(selected) =>
                            updateEdupageDraftStudent(student.id, (current) => ({
                              ...current,
                              selected,
                            }))
                          }
                          thumbColor="#FFFFFF"
                          trackColor={{ false: '#C8CDC8', true: '#2F7D63' }}
                          value={student.selected}
                        />
                      </View>
                    ))
                  )}
                </View>

                <View style={styles.draftActions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={selectionActive}
                    onPress={() => setEdupageDraft(null)}
                    style={({ pressed }) => [
                      styles.secondaryButton,
                      pressed && styles.pressed,
                      selectionActive && styles.disabledButton,
                    ]}
                  >
                    <Text style={styles.secondaryButtonText}>Abbrechen</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={editControlsDisabled}
                    onPress={confirmEdupageImport}
                    style={({ pressed }) => [
                      styles.importButton,
                      pressed && styles.pressed,
                      editControlsDisabled && styles.disabledButton,
                    ]}
                  >
                    <Text style={styles.importButtonText}>Übernehmen</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {currentView === 'students' && activeCourse && (
              <>
                <View style={styles.listHeader}>
                  <View style={styles.listTitleBlock}>
                    <Text style={styles.panelTitle}>Schüler</Text>
                    <View style={styles.sortControls}>
                      <Text style={styles.sortLabel}>Sortieren</Text>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setStudentSortMode('name')}
                        style={({ pressed }) => [
                          styles.sortButton,
                          studentSortMode === 'name' && styles.activeSortButton,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text
                          style={[
                            styles.sortButtonText,
                            studentSortMode === 'name' && styles.activeSortButtonText,
                          ]}
                        >
                          A-Z
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setStudentSortMode('chance')}
                        style={({ pressed }) => [
                          styles.sortButton,
                          studentSortMode === 'chance' && styles.activeSortButton,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text
                          style={[
                            styles.sortButtonText,
                            studentSortMode === 'chance' && styles.activeSortButtonText,
                          ]}
                        >
                          Chance
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                  <Text style={styles.message}>{hydrated ? message : 'Lade Daten...'}</Text>
                </View>

                <View style={styles.studentList}>
                  {students.length === 0 ? (
                    <View style={styles.emptyState}>
                      <Text style={styles.emptyStateTitle}>Keine Namen in der Liste</Text>
                      <Text style={styles.emptyStateText}>
                        Bearbeitungsmodus einschalten und Schüler hinzufügen oder importieren.
                      </Text>
                    </View>
                  ) : (
                    sortedStudents.map((student) => {
                      const studentProbability = selectionProbabilities[student.id] ?? 0;
                      const chanceLevel = getChanceLevel(studentProbability, averageSelectionProbability);

                      return (
                        <View
                          key={student.id}
                          style={[
                            styles.studentRow,
                            chanceLevel === 'high' && styles.highChanceStudentRow,
                            chanceLevel === 'medium' && styles.mediumChanceStudentRow,
                            chanceLevel === 'low' && styles.lowChanceStudentRow,
                            !editMode && styles.studentRowCompact,
                            highlightedStudentId === student.id && styles.selectedStudentRow,
                          ]}
                        >
                          <View
                            style={[
                              styles.chanceMarker,
                              chanceLevel === 'high' && styles.highChanceMarker,
                              chanceLevel === 'medium' && styles.mediumChanceMarker,
                              chanceLevel === 'low' && styles.lowChanceMarker,
                            ]}
                          />
                          <StudentImageView
                            imageStyle={[styles.studentImage, !editMode && styles.studentImageCompact]}
                            placeholderStyle={styles.studentImagePlaceholder}
                            placeholderTextStyle={[
                              styles.studentImagePlaceholderText,
                              !editMode && styles.studentImagePlaceholderTextCompact,
                            ]}
                            student={student}
                          />
                          <View style={[styles.studentMain, !editMode && styles.studentMainCompact]}>
                            {editMode ? (
                              <TextInput
                                autoCapitalize="words"
                                editable={!editControlsDisabled}
                                onChangeText={(name) => updateStudent(student.id, (current) => ({ ...current, name }))}
                                style={[
                                  styles.nameInput,
                                  styles.studentNameEditInput,
                                  editControlsDisabled && styles.disabledNameInput,
                                ]}
                                value={student.name}
                              />
                            ) : (
                              <Text
                                numberOfLines={1}
                                style={styles.nameTextCompact}
                              >
                                {student.name}
                              </Text>
                            )}
                            {editMode && (
                              <Pressable
                                accessibilityRole="button"
                                disabled={editControlsDisabled}
                                onPress={() => openStudentImageEditor(student)}
                                style={({ pressed }) => [
                                  styles.inlineImageButton,
                                  pressed && styles.pressed,
                                  editControlsDisabled && styles.disabledButton,
                                ]}
                              >
                                <Text style={styles.inlineImageButtonText}>Bild bearbeiten</Text>
                              </Pressable>
                            )}
                            <Text
                              style={[
                                styles.probabilityText,
                                chanceLevel === 'high' && styles.highChanceText,
                                chanceLevel === 'medium' && styles.mediumChanceText,
                                chanceLevel === 'low' && styles.lowChanceText,
                                !editMode && styles.probabilityTextCompact,
                              ]}
                            >
                              Chance: {formatProbability(studentProbability)}
                              {!editMode ? ` · ${student.count}x` : ''}
                            </Text>
                          </View>

                          {editMode && (
                            <View style={styles.counterControls}>
                              <Pressable
                                accessibilityRole="button"
                                disabled={editControlsDisabled}
                                onPress={() =>
                                  updateStudent(student.id, (current) => ({
                                    ...current,
                                    count: Math.max(0, current.count - 1),
                                  }))
                                }
                                style={({ pressed }) => [
                                  styles.iconButton,
                                  pressed && styles.pressed,
                                  editControlsDisabled && styles.disabledButton,
                                ]}
                              >
                                <Text style={styles.iconButtonText}>-</Text>
                              </Pressable>
                              <View style={styles.countPill}>
                                <Text style={styles.countNumber}>{student.count}</Text>
                              </View>
                              <Pressable
                                accessibilityRole="button"
                                disabled={editControlsDisabled}
                                onPress={() =>
                                  updateStudent(student.id, (current) => ({
                                    ...current,
                                    count: current.count + 1,
                                  }))
                                }
                                style={({ pressed }) => [
                                  styles.iconButton,
                                  pressed && styles.pressed,
                                  editControlsDisabled && styles.disabledButton,
                                ]}
                              >
                                <Text style={styles.iconButtonText}>+</Text>
                              </Pressable>
                              <Pressable
                                accessibilityLabel={`${student.name} entfernen`}
                                accessibilityRole="button"
                                disabled={editControlsDisabled}
                                onPress={() => removeStudent(student.id)}
                                style={({ pressed }) => [
                                  styles.deleteButton,
                                  pressed && styles.pressed,
                                  editControlsDisabled && styles.disabledButton,
                                ]}
                              >
                                <Text style={styles.deleteButtonText}>x</Text>
                              </Pressable>
                            </View>
                          )}
                        </View>
                      );
                    })
                  )}
                </View>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F7F2',
  },
  keyboardView: {
    flex: 1,
  },
  page: {
    flexGrow: 1,
    padding: 14,
  },
  shell: {
    alignSelf: 'center',
    gap: 14,
    maxWidth: 980,
    width: '100%',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    justifyContent: 'space-between',
    paddingTop: 8,
  },
  headerCompact: {
    alignItems: 'stretch',
    flexDirection: 'column',
  },
  headerTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  kicker: {
    color: '#557065',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  title: {
    color: '#17231E',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 38,
  },
  titleCompact: {
    fontSize: 28,
    lineHeight: 34,
  },
  summary: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 92,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  summaryCompact: {
    alignSelf: 'flex-start',
  },
  summaryNumber: {
    color: '#245D4A',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 32,
  },
  summaryLabel: {
    color: '#52625A',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  editModePanel: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  editModeTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  editModeMeta: {
    color: '#557065',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
    marginTop: 3,
  },
  imageBrightnessOverlay: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  adjustedImageFrame: {
    overflow: 'hidden',
  },
  adjustedImage: {
    height: '100%',
    width: '100%',
  },
  imageEditorModal: {
    backgroundColor: '#F4F7F2',
    flex: 1,
  },
  imageEditorHeader: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderBottomColor: '#DCE3DC',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  imageEditorTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  imageEditorTitle: {
    color: '#17231E',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 29,
  },
  imageEditorBody: {
    gap: 14,
    padding: 16,
  },
  infoModal: {
    backgroundColor: '#F4F7F2',
    flex: 1,
  },
  infoHeader: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderBottomColor: '#DCE3DC',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  infoTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  infoTitle: {
    color: '#17231E',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 29,
  },
  infoBody: {
    gap: 12,
    padding: 16,
  },
  infoPanel: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  infoSectionTitle: {
    color: '#17231E',
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 0,
  },
  infoText: {
    color: '#52625A',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0,
    lineHeight: 22,
  },
  imageEditorPreview: {
    alignSelf: 'center',
    backgroundColor: '#E6EEE8',
    borderColor: '#C9D3CC',
    borderRadius: 8,
    borderWidth: 1,
    height: 260,
    overflow: 'hidden',
    width: 260,
  },
  imageEditorPreviewImage: {
    height: '100%',
    width: '100%',
  },
  imageEditorEmptyPreview: {
    alignItems: 'center',
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
  imageEditorActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'center',
  },
  editorControlPanel: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 12,
  },
  editorStepperRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  editorStepperLabel: {
    color: '#52625A',
    flex: 1,
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0,
  },
  editorStepperButtons: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  editorValueText: {
    color: '#17231E',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0,
    minWidth: 54,
    textAlign: 'center',
  },
  inlineImageButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#F8FAF7',
    borderColor: '#C9D3CC',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 30,
    paddingHorizontal: 10,
  },
  inlineImageButtonText: {
    color: '#245D4A',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0,
  },
  homeHeader: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
  },
  homeHeaderActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'flex-end',
  },
  infoButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#C9D3CC',
    borderRadius: 18,
    borderWidth: 1,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  infoButtonText: {
    color: '#245D4A',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 22,
  },
  homeMeta: {
    color: '#557065',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
    marginTop: 4,
  },
  courseGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  courseCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: 180,
    flexGrow: 1,
    justifyContent: 'space-between',
    minHeight: 92,
    padding: 14,
  },
  activeCourseCard: {
    borderColor: '#2F7D63',
    borderWidth: 2,
  },
  courseCardTitle: {
    color: '#17231E',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 24,
  },
  courseCardMeta: {
    color: '#557065',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
    marginTop: 12,
  },
  detailHeader: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    padding: 12,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: '#F8FAF7',
    borderColor: '#C9D3CC',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 12,
  },
  backButtonText: {
    color: '#245D4A',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0,
  },
  detailTitleBlock: {
    flex: 1,
    minWidth: 160,
  },
  detailTitle: {
    color: '#17231E',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 29,
  },
  detailMeta: {
    color: '#557065',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
    marginTop: 3,
  },
  detailSelectButton: {
    minHeight: 46,
    minWidth: 132,
  },
  selectionTimingPanel: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
    padding: 12,
  },
  selectionTimingCopy: {
    flex: 1,
    minWidth: 210,
  },
  selectionTimingTitle: {
    color: '#17231E',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0,
  },
  selectionTimingMeta: {
    color: '#557065',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
    marginTop: 3,
  },
  selectionTimingControls: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  timingStepButton: {
    alignItems: 'center',
    backgroundColor: '#F8FAF7',
    borderColor: '#C9D3CC',
    borderRadius: 8,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  timingStepButtonText: {
    color: '#245D4A',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 28,
  },
  timingValuePill: {
    alignItems: 'center',
    backgroundColor: '#17231E',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 40,
    minWidth: 82,
    paddingHorizontal: 12,
  },
  timingValueText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0,
  },
  selectionModal: {
    backgroundColor: '#17231E',
    flex: 1,
  },
  fireworksLayer: {
    bottom: 0,
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 30,
  },
  fireworkParticle: {
    borderRadius: 999,
    position: 'absolute',
    zIndex: 2,
  },
  fireworkRocket: {
    alignItems: 'center',
    position: 'absolute',
    width: 12,
    zIndex: 1,
  },
  fireworkRocketHead: {
    borderRadius: 5,
    height: 10,
    shadowColor: '#FFFFFF',
    shadowOffset: { height: 0, width: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 5,
    width: 10,
  },
  fireworkRocketTrail: {
    borderRadius: 3,
    marginTop: 2,
    opacity: 0.58,
    width: 4,
  },
  selectionModalHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  selectionModalTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  selectionModalKicker: {
    color: '#A9C7B9',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  selectionModalTitle: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 34,
  },
  modalCloseButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 14,
  },
  modalCloseButtonText: {
    color: '#17231E',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0,
  },
  selectionModalBody: {
    flex: 1,
    gap: 14,
    justifyContent: 'flex-start',
    padding: 18,
    paddingTop: 30,
  },
  selectionModalBodyCompact: {
    gap: 8,
    padding: 12,
    paddingTop: 10,
  },
  selectionHero: {
    alignItems: 'center',
    flexShrink: 1,
    gap: 10,
  },
  selectionStage: {
    alignItems: 'center',
    flexShrink: 1,
    justifyContent: 'center',
    minHeight: 236,
    overflow: 'hidden',
    width: '100%',
  },
  selectionStageCompact: {
    minHeight: 226,
  },
  selectionStageLabel: {
    color: '#DDECE3',
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 0,
    position: 'absolute',
    textTransform: 'uppercase',
    top: 0,
    zIndex: 2,
  },
  selectionStageLabelCompact: {
    fontSize: 15,
    top: 0,
  },
  selectionPulseRing: {
    backgroundColor: '#2F7D63',
    borderColor: '#F0C94A',
    borderRadius: 150,
    borderWidth: 2,
    height: 300,
    opacity: 0.3,
    position: 'absolute',
    width: 300,
  },
  selectionPulseRingAlert: {
    backgroundColor: '#FF0000',
    borderColor: '#FFD0D0',
  },
  selectionPulseRingClear: {
    backgroundColor: '#2F7D63',
    borderColor: '#A9C7B9',
  },
  selectionPulseRingFound: {
    backgroundColor: '#6F5800',
    borderColor: '#F0C94A',
  },
  selectionPulseRingCompact: {
    borderRadius: 94,
    height: 188,
    width: 188,
  },
  selectionSweep: {
    backgroundColor: '#F0C94A',
    borderRadius: 8,
    height: 6,
    position: 'absolute',
    top: 28,
    width: 116,
  },
  selectionSweepCompact: {
    top: 16,
    width: 86,
  },
  selectionHeroCard: {
    alignItems: 'center',
    gap: 6,
  },
  selectionHeroCardLowered: {
    marginTop: 34,
  },
  selectionHeroCardLoweredCompact: {
    marginTop: 30,
  },
  selectionHeroImage: {
    backgroundColor: '#E6EEE8',
    borderRadius: 8,
    height: 140,
    width: 140,
  },
  selectionHeroImageCompact: {
    height: 92,
    width: 92,
  },
  selectionHeroPlaceholder: {
    alignItems: 'center',
    backgroundColor: '#E6EEE8',
    borderRadius: 8,
    height: 140,
    justifyContent: 'center',
    width: 140,
  },
  selectionHeroPlaceholderCompact: {
    height: 92,
    width: 92,
  },
  selectionHeroPlaceholderText: {
    color: '#245D4A',
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: 0,
  },
  selectionHeroPlaceholderTextCompact: {
    fontSize: 34,
  },
  selectionHeroName: {
    color: '#FFFFFF',
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 52,
    textAlign: 'center',
  },
  selectionHeroNameCompact: {
    fontSize: 29,
    lineHeight: 34,
  },
  selectionHeroMeta: {
    color: '#F0C94A',
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 0,
    textAlign: 'center',
  },
  selectionHeroMetaCompact: {
    fontSize: 14,
  },
  selectionSuspenseBar: {
    alignItems: 'center',
    backgroundColor: '#22352D',
    borderColor: '#426A58',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    minHeight: 42,
    minWidth: 230,
    paddingHorizontal: 14,
  },
  selectionSuspenseBarCompact: {
    minHeight: 34,
    minWidth: 190,
    paddingHorizontal: 10,
  },
  selectionSuspenseText: {
    color: '#DDECE3',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  selectionDotRow: {
    flexDirection: 'row',
    gap: 5,
  },
  selectionDot: {
    backgroundColor: '#557065',
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  selectionDotActive: {
    backgroundColor: '#F0C94A',
  },
  modalStatusPanel: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    gap: 8,
    marginTop: -2,
    maxHeight: 178,
    minHeight: 126,
    overflow: 'hidden',
    padding: 12,
  },
  modalStatusPanelCompact: {
    gap: 6,
    maxHeight: 138,
    minHeight: 104,
    padding: 8,
  },
  modalPresencePrompt: {
    backgroundColor: '#FFFFFF',
    borderColor: '#F0C94A',
    borderRadius: 8,
    borderWidth: 2,
    gap: 12,
    padding: 14,
  },
  modalPresencePromptCompact: {
    gap: 8,
    padding: 10,
  },
  modalPresenceTitle: {
    color: '#17231E',
    fontSize: 19,
    fontWeight: '900',
    letterSpacing: 0,
    textAlign: 'center',
  },
  modalPresenceTitleCompact: {
    fontSize: 16,
    lineHeight: 20,
  },
  modalPromptActions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
  },
  modalAnswerButton: {
    flex: 1,
    maxWidth: 180,
  },
  selectionBand: {
    alignItems: 'center',
    backgroundColor: '#17231E',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 18,
    justifyContent: 'space-between',
    minHeight: 170,
    padding: 22,
  },
  selectionBandCompact: {
    alignItems: 'stretch',
    flexDirection: 'column',
  },
  selectionCopy: {
    flex: 1,
    minWidth: 0,
  },
  sectionLabel: {
    color: '#A9C7B9',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  selectedName: {
    color: '#FFFFFF',
    fontSize: 48,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 56,
    marginTop: 8,
  },
  emptySelectedName: {
    color: '#D5DDD8',
    fontSize: 38,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 46,
    marginTop: 8,
  },
  selectedMeta: {
    color: '#F0C94A',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0,
    marginTop: 8,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#F0C94A',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 58,
    minWidth: 156,
    paddingHorizontal: 18,
  },
  primaryButtonCompact: {
    width: '100%',
  },
  primaryButtonText: {
    color: '#1F2214',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0,
  },
  disabledButton: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.78,
  },
  coursePanel: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  courseHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  courseMeta: {
    color: '#557065',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
  },
  courseTabs: {
    gap: 8,
    paddingRight: 4,
  },
  courseTab: {
    alignItems: 'center',
    backgroundColor: '#F8FAF7',
    borderColor: '#C9D3CC',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    maxWidth: 220,
    minHeight: 40,
    paddingHorizontal: 12,
  },
  activeCourseTab: {
    backgroundColor: '#17231E',
    borderColor: '#17231E',
  },
  courseTabText: {
    color: '#245D4A',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0,
  },
  activeCourseTabText: {
    color: '#FFFFFF',
  },
  courseForms: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  courseNameInput: {
    flexBasis: 240,
  },
  newCourseForm: {
    alignItems: 'center',
    flexBasis: 280,
    flexDirection: 'row',
    flexGrow: 1,
    gap: 10,
  },
  selectionStatus: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    padding: 12,
  },
  statusLabel: {
    color: '#557065',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  statusMeta: {
    color: '#52625A',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0,
  },
  statusMetaCompact: {
    fontSize: 12,
  },
  skippedList: {
    alignContent: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  skippedPanelHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  skippedScrollArea: {
    maxHeight: 126,
  },
  skippedScrollAreaCompact: {
    maxHeight: 86,
  },
  skippedPill: {
    alignItems: 'center',
    backgroundColor: '#FFF8D8',
    borderColor: '#EDD06B',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 10,
  },
  skippedName: {
    color: '#17231E',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0,
    maxWidth: 116,
  },
  skippedCount: {
    color: '#8D6F00',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0,
  },
  presencePrompt: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#F0C94A',
    borderRadius: 8,
    borderWidth: 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    justifyContent: 'space-between',
    padding: 14,
  },
  promptCopy: {
    flex: 1,
    minWidth: 220,
  },
  promptMeta: {
    color: '#52625A',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0,
    marginTop: 4,
  },
  promptActions: {
    flexDirection: 'row',
    gap: 10,
  },
  noButton: {
    alignItems: 'center',
    backgroundColor: '#FFF1ED',
    borderColor: '#F2C2B8',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 46,
    minWidth: 90,
    paddingHorizontal: 14,
  },
  noButtonText: {
    color: '#A83E31',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0,
  },
  yesButton: {
    alignItems: 'center',
    backgroundColor: '#2F7D63',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 46,
    minWidth: 90,
    paddingHorizontal: 14,
  },
  yesButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0,
  },
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#C9D3CC',
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#245D4A',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0,
  },
  warningButton: {
    alignItems: 'center',
    backgroundColor: '#FFF1ED',
    borderColor: '#F2C2B8',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 14,
  },
  warningButtonText: {
    color: '#A83E31',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0,
  },
  inputGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  inputPanel: {
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: 320,
    flexGrow: 1,
    gap: 10,
    padding: 14,
  },
  panelTitle: {
    color: '#17231E',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0,
  },
  inlineForm: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  textInput: {
    backgroundColor: '#F8FAF7',
    borderColor: '#C9D3CC',
    borderRadius: 8,
    borderWidth: 1,
    color: '#17231E',
    flex: 1,
    fontSize: 16,
    letterSpacing: 0,
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  disabledInput: {
    opacity: 0.62,
  },
  importInput: {
    minHeight: 88,
  },
  importActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  addButton: {
    alignItems: 'center',
    backgroundColor: '#2F7D63',
    borderRadius: 8,
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 0,
    lineHeight: 30,
  },
  importButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#315AA3',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 14,
  },
  importButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0,
  },
  fileImportButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderColor: '#315AA3',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 14,
  },
  fileImportButtonText: {
    color: '#315AA3',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0,
  },
  edupageDraftPanel: {
    backgroundColor: '#FFFFFF',
    borderColor: '#C9D3CC',
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  edupageDraftHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
  },
  edupageDraftTitleBlock: {
    flex: 1,
    minWidth: 220,
  },
  draftMeta: {
    color: '#52625A',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
    marginTop: 4,
  },
  draftCourseInput: {
    flexBasis: 260,
  },
  warningStrip: {
    backgroundColor: '#FFF8D8',
    borderColor: '#EDD06B',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  warningStripText: {
    color: '#6F5800',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
  },
  draftStudentList: {
    gap: 8,
  },
  draftStudentRow: {
    alignItems: 'center',
    backgroundColor: '#F8FAF7',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: 68,
    padding: 10,
  },
  draftStudentMain: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  draftNameInput: {
    minHeight: 30,
  },
  draftWarningText: {
    color: '#A83E31',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0,
  },
  draftActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'flex-end',
  },
  listHeader: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between',
  },
  listTitleBlock: {
    gap: 8,
  },
  sortControls: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  sortLabel: {
    color: '#557065',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  sortButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#C9D3CC',
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: 10,
  },
  activeSortButton: {
    backgroundColor: '#17231E',
    borderColor: '#17231E',
  },
  sortButtonText: {
    color: '#245D4A',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0,
  },
  activeSortButtonText: {
    color: '#FFFFFF',
  },
  message: {
    color: '#557065',
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0,
    textAlign: 'right',
  },
  studentList: {
    gap: 1,
  },
  emptyState: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    padding: 24,
  },
  emptyStateTitle: {
    color: '#17231E',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0,
    textAlign: 'center',
  },
  emptyStateText: {
    color: '#52625A',
    fontSize: 14,
    letterSpacing: 0,
    marginTop: 6,
    textAlign: 'center',
  },
  studentRow: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#DCE3DC',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
    minHeight: 66,
    padding: 8,
  },
  highChanceStudentRow: {
    backgroundColor: '#FFF3F1',
    borderColor: '#F0B7AE',
  },
  mediumChanceStudentRow: {
    backgroundColor: '#FFF8EA',
    borderColor: '#EDCF8E',
  },
  lowChanceStudentRow: {
    backgroundColor: '#F2FAF6',
    borderColor: '#BFD9CD',
  },
  studentRowCompact: {
    flexWrap: 'nowrap',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  chanceMarker: {
    alignSelf: 'stretch',
    borderRadius: 4,
    flexShrink: 0,
    width: 5,
  },
  highChanceMarker: {
    backgroundColor: '#D94A3A',
  },
  mediumChanceMarker: {
    backgroundColor: '#E59A2E',
  },
  lowChanceMarker: {
    backgroundColor: '#2F7D63',
  },
  studentImage: {
    backgroundColor: '#E6EEE8',
    borderRadius: 8,
    height: 54,
    width: 54,
  },
  studentImageCompact: {
    borderRadius: 7,
    height: 30,
    width: 30,
  },
  studentImagePlaceholder: {
    alignItems: 'center',
    backgroundColor: '#E6EEE8',
    borderRadius: 8,
    height: 54,
    justifyContent: 'center',
    width: 54,
  },
  studentImagePlaceholderText: {
    color: '#245D4A',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0,
  },
  studentImagePlaceholderTextCompact: {
    fontSize: 13,
  },
  selectedStudentRow: {
    borderColor: '#F0C94A',
    borderWidth: 2,
  },
  studentMain: {
    flex: 1,
    gap: 5,
    minWidth: 210,
  },
  studentMainCompact: {
    gap: 0,
    minWidth: 0,
  },
  nameInput: {
    color: '#17231E',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0,
    minHeight: 34,
    padding: 0,
  },
  studentNameEditInput: {
    backgroundColor: '#F8FAF7',
    borderColor: '#C9D3CC',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  nameTextCompact: {
    color: '#17231E',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 16,
  },
  disabledNameInput: {
    opacity: 0.68,
  },
  probabilityText: {
    color: '#315AA3',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0,
  },
  highChanceText: {
    color: '#B83226',
  },
  mediumChanceText: {
    color: '#9C6508',
  },
  lowChanceText: {
    color: '#245D4A',
  },
  probabilityTextCompact: {
    fontSize: 10,
    lineHeight: 12,
  },
  counterControls: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: 6,
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: '#E6EEE8',
    borderRadius: 8,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  iconButtonText: {
    color: '#245D4A',
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 24,
  },
  countPill: {
    alignItems: 'center',
    backgroundColor: '#17231E',
    borderRadius: 8,
    height: 36,
    justifyContent: 'center',
    minWidth: 46,
    paddingHorizontal: 10,
  },
  countNumber: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0,
  },
  deleteButton: {
    alignItems: 'center',
    backgroundColor: '#FFF1ED',
    borderRadius: 8,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  deleteButtonText: {
    color: '#A83E31',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 0,
    lineHeight: 22,
  },
});
