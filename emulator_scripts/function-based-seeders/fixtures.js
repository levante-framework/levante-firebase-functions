const ADMIN_USERS = [
  {
    key: 'admin',
    email: 'admin@levante.test',
    name: { first: 'Admin', middle: '', last: 'User' },
    role: 'admin',
  },
  {
    key: 'siteAdmin',
    email: 'siteadmin@levante.test',
    name: { first: 'Site Admin', middle: '', last: 'User' },
    role: 'site_admin',
  },
  {
    key: 'researchAssistant',
    email: 'ra@levante.test',
    name: { first: 'Research Assistant', middle: '', last: 'User' },
    role: 'research_assistant',
  },
];

const ORG_FIXTURES = {
  siteName: 'Function Seed District',
  schoolName: 'Function Seed Elementary School',
  originalClassName: '3rd Grade - Room 101',
  newClassName: '4th Grade - Room 102',
  cohortName: 'Reading Intervention Cohort',
};

const ADMINISTRATION_TEMPLATES = [
  {
    templateId: 'reading-assessment-1',
    name: 'Basic Reading Assessment',
    publicName: 'Reading Skills Evaluation',
    taskIds: ['pa', 'sre', 'swr'],
    sequential: false,
    tags: ['reading', 'literacy', 'basic'],
    daysToClose: 30,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'cognitive-assessment-1',
    name: 'Cognitive Assessment Battery',
    publicName: 'Thinking Skills Assessment',
    taskIds: ['matrix-reasoning', 'mental-rotation', 'memory-game'],
    sequential: false,
    tags: ['cognitive', 'reasoning', 'memory'],
    daysToClose: 21,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'comprehensive-assessment-1',
    name: 'Comprehensive Academic Assessment',
    publicName: 'Complete Learning Evaluation',
    taskIds: ['vocab', 'egma-math', 'trog', 'theory-of-mind'],
    sequential: false,
    tags: ['comprehensive', 'academic', 'language'],
    daysToClose: 45,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'executive-function-assessment',
    name: 'Executive Function Assessment',
    publicName: 'Focus and Control Skills Test',
    taskIds: ['hearts-and-flowers', 'MEFS', 'same-different-selection'],
    sequential: false,
    tags: ['executive-function', 'attention', 'control'],
    daysToClose: 14,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
    optional: true,
  },
  {
    templateId: 'mixed-assessment-battery',
    name: 'Mixed Skills Assessment',
    publicName: 'General Skills Evaluation',
    taskIds: ['intro', 'pa', 'matrix-reasoning', 'vocab'],
    sequential: false,
    tags: ['mixed', 'general', 'evaluation'],
    daysToClose: 60,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'survey-administration',
    name: 'Background Survey',
    publicName: 'Background Information Survey',
    taskIds: ['survey'],
    sequential: true,
    tags: ['survey', 'background', 'information'],
    daysToClose: 90,
    optional: true,
  },
];

const DEFAULT_LEGAL = {
  amount: '0',
  assent: null,
  consent: 'I consent to the terms of the Levante Privacy Policy and Terms of Service.',
  expectedTime: '30 minutes',
};

function normalizeToLowercase(value = '') {
  return value.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function chunk(array, size) {
  const chunks = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}

function buildParticipantRows({ siteId, schoolId, originalClassId, newClassId, cohortId, studentCount = 200 }) {
  const baseOrgIds = {
    districts: [siteId],
    schools: [schoolId],
    groups: [cohortId],
    families: [],
  };

  const rowForClass = (row, classId) => ({
    ...row,
    orgIds: {
      ...baseOrgIds,
      classes: [classId],
    },
    isTestData: false,
  });

  return [
    rowForClass(
      {
        id: 'teacher',
        userType: 'teacher',
        month: '',
        year: '',
      },
      originalClassId,
    ),
    rowForClass(
      {
        id: 'student',
        userType: 'child',
        month: '1',
        year: '2018',
      },
      originalClassId,
    ),
    rowForClass(
      {
        id: 'parent',
        userType: 'parent',
        month: '',
        year: '',
      },
      newClassId,
    ),
    ...Array.from({ length: studentCount }, (_, index) => {
      const studentNumber = index + 1;
      return rowForClass(
        {
          id: `student${studentNumber}`,
          userType: 'child',
          month: String((studentNumber % 12) + 1),
          year: '2018',
        },
        studentNumber <= Math.ceil(studentCount / 2) ? newClassId : originalClassId,
      );
    }),
  ];
}

module.exports = {
  ADMIN_USERS,
  ADMINISTRATION_TEMPLATES,
  DEFAULT_LEGAL,
  ORG_FIXTURES,
  buildParticipantRows,
  chunk,
  normalizeToLowercase,
};
