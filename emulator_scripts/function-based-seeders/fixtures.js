const ADMIN_USERS = [
  {
    key: "admin",
    email: "admin@levante.test",
    name: { first: "Admin", middle: "", last: "User" },
    role: "admin",
  },
  {
    key: "siteAdmin",
    email: "siteadmin@levante.test",
    name: { first: "Site Admin", middle: "", last: "User" },
    role: "site_admin",
  },
  {
    key: "researchAssistant",
    email: "ra@levante.test",
    name: { first: "Research Assistant", middle: "", last: "User" },
    role: "research_assistant",
  },
];

const ORG_FIXTURES = {
  siteName: "Function Seed District",
  schoolName: "Function Seed Elementary School",
  originalClassName: "3rd Grade - Room 101",
  newClassName: "4th Grade - Room 102",
  cohortName: "Reading Intervention Cohort",
  caregiverCohortName: "Caregiver Linking Cohort",
};

const ADMINISTRATION_TEMPLATES = [
  {
    templateId: "reading-assessment-1",
    name: "Basic Reading Assessment",
    taskIds: ["pa", "sre", "swr"],
    sequential: false,
    daysToClose: 30,
    assignedCondition: { field: "userType", op: "EQUAL", value: "student" },
  },
  {
    templateId: "cognitive-assessment-1",
    name: "Cognitive Assessment Battery",
    taskIds: ["matrix-reasoning", "mental-rotation", "memory-game"],
    sequential: false,
    daysToClose: 21,
    assignedCondition: { field: "userType", op: "EQUAL", value: "student" },
  },
  {
    templateId: "comprehensive-assessment-1",
    name: "Comprehensive Academic Assessment",
    taskIds: ["vocab", "egma-math", "trog", "theory-of-mind"],
    sequential: false,
    daysToClose: 45,
    assignedCondition: { field: "userType", op: "EQUAL", value: "student" },
  },
  {
    templateId: "mixed-assessment-battery",
    name: "Mixed Skills Assessment",
    taskIds: ["intro", "pa", "matrix-reasoning", "vocab"],
    sequential: false,
    daysToClose: 60,
    assignedCondition: { field: "userType", op: "EQUAL", value: "student" },
  },
  {
    templateId: "survey-administration",
    name: "Background Survey",
    taskIds: ["survey"],
    sequential: true,
    daysToClose: 90,
    optional: true,
  },
];

// Survey administration scoped to the dedicated caregiver-linking cohort. Each
// survey task carries the same userType condition the dashboard applies, so
// caregivers receive the caregiver survey and their children the child survey.
const CAREGIVER_SURVEY_TEMPLATE = {
  templateId: "caregiver-linking-survey",
  name: "Caregiver Linking Survey",
  sequential: false,
  daysToClose: 90,
  tasks: [
    {
      taskId: "caregiver-survey",
      assignedCondition: { field: "userType", op: "EQUAL", value: "parent" },
    },
    {
      taskId: "child-survey",
      assignedCondition: { field: "userType", op: "EQUAL", value: "student" },
    },
  ],
};

const DEFAULT_LEGAL = {
  amount: "0",
  assent: null,
  consent:
    "I consent to the terms of the Levante Privacy Policy and Terms of Service.",
  expectedTime: "30 minutes",
};
const CHILD_BIRTH_YEARS = [
  "2014",
  "2015",
  "2016",
  "2017",
  "2018",
  "2019",
  "2020",
  "2021",
  "2022",
  "2023",
  "2024",
];

function normalizeToLowercase(value = "") {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function chunk(array, size) {
  const chunks = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}

// Caregivers with 0, 1, and 2 linked children, isolated in their own cohort so
// they can be targeted by a dedicated survey administration. All created users
// still belong to the site district (createUsers derives that from siteId), so
// the linked children also receive the site's student-conditioned assignments.
function buildCaregiverLinkingRows({ siteId, caregiverCohortId }) {
  const orgIds = {
    districts: [siteId],
    schools: [],
    classes: [],
    cohorts: [caregiverCohortId],
  };
  const cohortRow = (row) => ({ ...row, orgIds, isTestData: false });

  return [
    cohortRow({ id: "caregiverNoChild", userType: "caregiver" }),
    cohortRow({ id: "caregiverOneChild", userType: "caregiver" }),
    cohortRow({ id: "caregiverTwoChildren", userType: "caregiver" }),
    cohortRow({
      id: "childOfOneCaregiver",
      userType: "child",
      month: 3,
      year: 2019,
      parentId: "caregiverOneChild",
    }),
    cohortRow({
      id: "childOfTwoCaregiversA",
      userType: "child",
      month: 4,
      year: 2019,
      parentId: "caregiverTwoChildren",
    }),
    cohortRow({
      id: "childOfTwoCaregiversB",
      userType: "child",
      month: 5,
      year: 2020,
      parentId: "caregiverTwoChildren",
    }),
  ];
}

function buildParticipantRows({
  siteId,
  schoolId,
  originalClassId,
  newClassId,
  cohortId,
  caregiverCohortId,
  studentCount = 200,
}) {
  const baseOrgIds = {
    districts: [siteId],
    schools: [schoolId],
    cohorts: [],
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
        id: "teacher",
        userType: "teacher",
      },
      originalClassId
    ),
    rowForClass(
      {
        id: "student",
        userType: "child",
        month: 1,
        year: 2018,
        parentId: "parent",
        teacherId: "teacher",
      },
      originalClassId
    ),
    rowForClass(
      {
        id: "parent",
        userType: "caregiver",
      },
      newClassId
    ),
    ...Array.from({ length: studentCount }, (_, index) => {
      const studentNumber = index + 1;
      return rowForClass(
        {
          id: `student${studentNumber}`,
          userType: "child",
          month: (studentNumber % 12) + 1,
          year: Number(CHILD_BIRTH_YEARS[index % CHILD_BIRTH_YEARS.length]),
          parentId: "parent",
          teacherId: "teacher",
        },
        studentNumber <= Math.ceil(studentCount / 2)
          ? newClassId
          : originalClassId
      );
    }),
    ...buildCaregiverLinkingRows({ siteId, caregiverCohortId }),
  ];
}

module.exports = {
  ADMIN_USERS,
  ADMINISTRATION_TEMPLATES,
  CAREGIVER_SURVEY_TEMPLATE,
  DEFAULT_LEGAL,
  ORG_FIXTURES,
  buildCaregiverLinkingRows,
  buildParticipantRows,
  chunk,
  normalizeToLowercase,
};
