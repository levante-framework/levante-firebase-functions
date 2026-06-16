/**
 * One-off generator: reads gitignored survey CSVs and writes emulator seed JSON
 * aligned with FormDefinition / FormDefinitionVersion in firestore-schema.ts.
 *
 * Usage (from levante-firebase-functions):
 *   node emulator_scripts/seed-data/org-information-forms/build-form-definition-seed.js
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** PascalCase / mixed spreadsheet names -> SchoolInformation / SiteInformation keys */
const VARIABLE_NAME_MAP = {
  SampleApproach: 'sampleApproach',
  SampleApproachOther: 'sampleApproachOther',
  SiteRecruitment: 'siteRecruitment',
  AdminApproach: 'adminApproach',
  AdminApproachOther: 'adminApproachOther',
  TestConditions: 'testConditions',
  EquipmentType: 'equipmentType',
  EquipmentDevices: 'equipmentDevices',
  SiteGeoArea: 'siteGeoArea',
  SiteGeoType: 'siteGeoType',
  SitePopulationSize: 'sitePopulationSize',
  SiteRaceEthnicity: 'siteRaceEthnicity',
  SiteSES: 'siteSES',
  SiteLifestyle: 'siteLifestyle',
  SiteTech: 'siteTech',
  SiteLanguages: 'siteLanguages',
  SiteSubsistence: 'siteSubsistence',
  SchoolingAgeStart: 'schoolingAgeStart',
  SchoolingAgeEnd: 'schoolingAgeEnd',
  SchoolingProgression: 'schoolingProgression',
  SchoolingTeacherQuals: 'schoolingTeacherQuals',
  AnythingElse: 'anythingElse',
  NumStudents: 'numStudents',
  StudentAges: 'studentAges',
  NumTeachers: 'numTeachers',
  TeacherStudentRatio: 'studentsPerTeacher',
  AvgClassSize: 'avgClassSize',
  SchoolFunding: 'schoolFunding',
  SchoolReligious: 'schoolReligious',
  SchoolTuition: 'schoolTuition',
  SchoolSelectiveness: 'schoolSelectiveness',
  SchoolSelectivenessOther: 'schoolSelectivenessOther',
  InstructionLanguages: 'instructionLanguages',
  SchoolDayLength: 'schoolDayLength',
  TeacherQuals: 'teacherQuals',
  Site: 'site',
  SchoolPseudonym: 'schoolPseudonym',
};

const SITE_RESPONSE_KEYS = new Set([
  'siteId',
  'sampleApproach',
  'sampleApproachOther',
  'siteRecruitment',
  'adminApproach',
  'adminApproachOther',
  'testConditions',
  'equipmentType',
  'equipmentDevices',
  'siteGeoArea',
  'siteGeoType',
  'sitePopulationSize',
  'siteRaceEthnicity',
  'siteSES',
  'siteLifestyle',
  'siteTech',
  'siteLanguages',
  'siteSubsistence',
  'schoolingAgeStart',
  'schoolingAgeEnd',
  'schoolingProgression',
  'schoolingTeacherQuals',
  'anythingElse',
]);

const OPTION_OVERRIDES = {
  school_01: [
    { value: 'less_than_20', label: 'Fewer than 20 students' },
    { value: '20_to_49', label: '20-49 students' },
    { value: '50_to_149', label: '50-149 students' },
    { value: '150_to_499', label: '150-499 students' },
    { value: '500_to_999', label: '500-999 students' },
    { value: '1000_to_1999', label: '1,000–1,999 students' },
    { value: '2000_or_more', label: '2,000 or more students' },
  ],
  school_09: [
    {
      value: 'selective',
      label:
        "By application, where selection is based on students' achievement or background",
    },
    {
      value: 'lottery_based',
      label: 'By application, where selection is lottery-based',
    },
    {
      value: 'residence_based',
      label:
        'Based on residence; the schools serves children who reside in a specific area',
    },
    { value: 'other', label: 'Other' },
  ],
  site_06: [
    { value: 'tablet', label: 'Tablet' },
    { value: 'computer', label: 'Computer (laptop or desktop)' },
  ],
};

const SCHOOL_RESPONSE_KEYS = new Set([
  'siteId',
  'siteName',
  'schoolId',
  'schoolPseudonym',
  'numStudents',
  'studentAgeYoungest',
  'studentAgeOldest',
  'numTeachers',
  'studentsPerTeacher',
  'avgClassSize',
  'schoolFunding',
  'schoolReligious',
  'schoolTuition',
  'schoolSelectiveness',
  'schoolSelectivenessOther',
  'instructionLanguages',
  'schoolDayLength',
  'teacherQuals',
]);

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || (char === '\r' && next === '\n')) {
      row.push(field);
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      field = '';
      if (char === '\r') i += 1;
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) {
      rows.push(row);
    }
  }

  const headers = rows.shift();
  return rows.map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
  );
}

function toCamelCase(variableName) {
  if (VARIABLE_NAME_MAP[variableName]) {
    return VARIABLE_NAME_MAP[variableName];
  }
  return variableName.charAt(0).toLowerCase() + variableName.slice(1);
}

function mapKind(responseType) {
  const normalized = responseType.trim().toLowerCase();
  if (normalized === 'multi-select') return 'multi-select';
  if (normalized === 'single-select') return 'single-select';
  if (
    normalized === 'open-ended numeric' ||
    normalized === 'numeric' ||
    normalized === 'integer' ||
    normalized === 'two integers'
  ) {
    return 'number';
  }
  return 'text';
}

function parseOptions(valuesRaw, labelsRaw, itemId) {
  if (OPTION_OVERRIDES[itemId]) {
    return { options: OPTION_OVERRIDES[itemId] };
  }

  if (!valuesRaw || valuesRaw === 'NA' || !labelsRaw || labelsRaw === 'NA') {
    return undefined;
  }

  const values = valuesRaw.split(',').map((v) => v.trim()).filter(Boolean);

  let labels;
  if (labelsRaw.includes('\n')) {
    labels = labelsRaw.split('\n').map((label) => label.trim()).filter(Boolean);
  } else {
    // Comma-separated labels; rejoin segments when there are more labels than values
    // (e.g. "1,000–1,999 students" contains a comma).
    const rawLabels = labelsRaw.split(',').map((label) => label.trim()).filter(Boolean);
    if (rawLabels.length === values.length) {
      labels = rawLabels;
    } else {
      labels = [];
      const slots = values.length;
      const chunkSize = Math.ceil(rawLabels.length / slots);
      for (let i = 0; i < slots; i += 1) {
        labels.push(rawLabels.slice(i * chunkSize, (i + 1) * chunkSize).join(', '));
      }
    }
  }

  if (values.length !== labels.length) {
    return {
      options: values.map((value, index) => ({
        value,
        label: labels[index] ?? value,
      })),
      warning: `Option count mismatch (${values.length} values, ${labels.length} labels)`,
    };
  }

  return {
    options: values.map((value, index) => ({ value, label: labels[index] })),
  };
}

const DISPLAY_LOGIC_FIELD_ALIASES = {
  administrationApproach: 'adminApproach',
  sampleApproach: 'sampleApproach',
};

function parseDisplayLogic(displayLogicRaw) {
  if (!displayLogicRaw) {
    return { displayLogic: undefined, required: true };
  }

  if (displayLogicRaw === 'required') {
    return { displayLogic: undefined, required: true };
  }

  const lower = displayLogicRaw.toLowerCase();
  if (lower.includes('not collected via dashboard')) {
    return { skip: true, reason: 'Collected by dashboard, not survey form' };
  }

  const match = displayLogicRaw.match(/If\s+(\w+)="?([^"]+)"?/i);
  if (match) {
    const referencedField = DISPLAY_LOGIC_FIELD_ALIASES[toCamelCase(match[1])] ?? toCamelCase(match[1]);
    const includes = match[2].toLowerCase();
    return {
      displayLogic: { field: referencedField, includes },
      required: true,
    };
  }

  return {
    warning: `Unparsed display_logic: ${displayLogicRaw}`,
    required: false,
  };
}

const FIELD_KIND_OVERRIDES = {
  schoolSelectiveness: 'multi-select',
};

const FIELD_DISPLAY_LOGIC_OVERRIDES = {
  schoolSelectivenessOther: { field: 'schoolSelectiveness', includes: 'other' },
};

function buildField(row, formType) {
  const itemId = row.item_id?.trim();
  const variableName = toCamelCase(row.variable_name?.trim() ?? '');
  const display = parseDisplayLogic(row.display_logic?.trim() ?? '');

  if (display.skip) {
    return { skip: true, itemId, variableName, reason: display.reason };
  }

  const kind = FIELD_KIND_OVERRIDES[variableName] ?? mapKind(row.response_type ?? '');
  const parsedOptions = parseOptions(row.response_options, row.response_options_text, itemId);

  const field = {
    itemId,
    variableName,
    kind,
    required: display.required,
    questionText: row.item_text?.trim() ?? '',
  };

  if (parsedOptions?.options) {
    field.options = parsedOptions.options;
  }

  if (display.displayLogic) {
    field.displayLogic = display.displayLogic;
  } else if (FIELD_DISPLAY_LOGIC_OVERRIDES[variableName]) {
    field.displayLogic = FIELD_DISPLAY_LOGIC_OVERRIDES[variableName];
  }

  const infoExample = row.response_options_text?.trim();
  if (
    infoExample &&
    infoExample !== 'NA' &&
    kind === 'number' &&
    (!row.response_options || row.response_options === 'NA')
  ) {
    field.infoExample = infoExample;
  }

  const notes = [row.misc_notes, row.review_comments, row.site_guidance, row.site_edit]
    .map((value) => value?.trim())
    .filter(Boolean);
  if (notes.length > 0) {
    field.notes = notes.join(' | ');
  }

  const responseKeys = formType === 'site' ? SITE_RESPONSE_KEYS : SCHOOL_RESPONSE_KEYS;
  const schemaGap =
    variableName !== 'studentAges' &&
    !responseKeys.has(variableName)
      ? `variableName "${variableName}" is not a key on ${formType === 'site' ? 'SiteInformation' : 'SchoolInformation'}`
      : undefined;

  return {
    field,
    warning: parsedOptions?.warning ?? display.warning,
    schemaGap,
  };
}

function expandSchoolAgeRangeRow(row, formType) {
  const base = buildField(row, formType);
  if (base.skip) return [base];

  if (row.variable_name?.trim() !== 'StudentAges') {
    return [base];
  }

  const guidance = row.response_options_text?.trim();
  return [
    {
      field: {
        itemId: 'school_02_youngest',
        variableName: 'studentAgeYoungest',
        kind: 'number',
        required: true,
        questionText: 'What is the typical age of the youngest students at this school?',
        infoExample: guidance || undefined,
        notes: base.field?.notes,
      },
    },
    {
      field: {
        itemId: 'school_02_oldest',
        variableName: 'studentAgeOldest',
        kind: 'number',
        required: true,
        questionText: 'What is the typical age of the oldest students at this school?',
        infoExample: guidance || undefined,
      },
    },
  ];
}

function buildFormSeed({ csvPath, formId, formDescription, formType }) {
  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(csvContent);

  const fullFields = [];
  const mappingNotes = [];
  const schemaGaps = [];
  const skippedRows = [];

  for (const row of rows) {
    if (row.item_id?.trim() === 'NA') {
      skippedRows.push({
        itemId: 'NA',
        variableName: toCamelCase(row.variable_name?.trim() ?? ''),
        reason: row.display_logic || 'Dashboard-provided identifier row',
      });
      continue;
    }

    const expanded = expandSchoolAgeRangeRow(row, formType);
    for (const result of expanded) {
      if (result.skip) {
        skippedRows.push({
          itemId: result.itemId,
          variableName: result.variableName,
          reason: result.reason,
        });
        continue;
      }

      if (result.warning) mappingNotes.push(`${result.field.itemId}: ${result.warning}`);
      if (result.schemaGap) schemaGaps.push(`${result.field.itemId}: ${result.schemaGap}`);

      if (row.variable_name?.trim() === 'EquipmentType') {
        mappingNotes.push(
          'site_06: CSV response_options uses "table"; seed uses "tablet" to match the Tablet label',
        );
      }

      fullFields.push(result.field);
    }
  }

  const fieldsDescription = Object.fromEntries(
    fullFields.map((field) => [field.variableName, field.questionText.split('\n')[0]]),
  );

  const versionId = 'v1';
  const now = '2026-06-16T00:00:00.000Z';

  return {
    collection: 'formDefinitions',
    documentId: formId,
    definition: {
      currentVersionId: versionId,
      formDescription,
      fieldsDescription,
    },
    versions: {
      [versionId]: {
        registered: true,
        versionNumber: 1,
        createdAt: now,
        updatedAt: now,
        liveFrom: now,
        liveUntil: null,
        fullFields,
      },
    },
    _meta: {
      sourceCsv: path.basename(csvPath),
      generatedAt: new Date().toISOString(),
      skippedRows,
      schemaGaps: [...new Set(schemaGaps)],
      mappingNotes: [...new Set(mappingNotes)],
      dashboardProvidedResponseFields:
        formType === 'site'
          ? ['siteId']
          : ['siteId', 'siteName', 'schoolId', 'schoolPseudonym'],
    },
  };
}

function main() {
  const outputDir = __dirname;

  const siteSeed = buildFormSeed({
    csvPath: path.join(REPO_ROOT, 'Site Survey - Sheet1.csv'),
    formId: 'siteInformation',
    formDescription: 'Site information survey for researchers characterizing a LEVANTE data collection site.',
    formType: 'site',
  });

  const schoolSeed = buildFormSeed({
    csvPath: path.join(REPO_ROOT, 'School Survey - Sheet1.csv'),
    formId: 'schoolInformation',
    formDescription: 'School information survey for researchers describing schools within a LEVANTE site.',
    formType: 'school',
  });

  fs.writeFileSync(
    path.join(outputDir, 'siteInformation.seed.json'),
    `${JSON.stringify(siteSeed, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(outputDir, 'schoolInformation.seed.json'),
    `${JSON.stringify(schoolSeed, null, 2)}\n`,
  );

  console.log('Wrote siteInformation.seed.json and schoolInformation.seed.json');
  for (const [label, seed] of [
    ['siteInformation', siteSeed],
    ['schoolInformation', schoolSeed],
  ]) {
    console.log(`\n${label}:`);
    console.log(`  fullFields: ${seed.versions.v1.fullFields.length}`);
    console.log(`  schema gaps: ${seed._meta.schemaGaps.length}`);
    seed._meta.schemaGaps.forEach((gap) => console.log(`    - ${gap}`));
    if (seed._meta.mappingNotes.length > 0) {
      console.log('  mapping notes:');
      seed._meta.mappingNotes.forEach((note) => console.log(`    - ${note}`));
    }
  }
}

main();
