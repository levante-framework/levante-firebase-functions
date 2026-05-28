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
    taskIds: ['pa', 'sre', 'swr'],
    sequential: false,
    daysToClose: 30,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'cognitive-assessment-1',
    name: 'Cognitive Assessment Battery',
    taskIds: ['matrix-reasoning', 'mental-rotation', 'memory-game'],
    sequential: false,
    daysToClose: 21,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'comprehensive-assessment-1',
    name: 'Comprehensive Academic Assessment',
    taskIds: ['vocab', 'egma-math', 'trog', 'theory-of-mind'],
    sequential: false,
    daysToClose: 45,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'mixed-assessment-battery',
    name: 'Mixed Skills Assessment',
    taskIds: ['intro', 'pa', 'matrix-reasoning', 'vocab'],
    sequential: false,
    daysToClose: 60,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'survey-administration',
    name: 'Background Survey',
    taskIds: ['survey'],
    sequential: true,
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
