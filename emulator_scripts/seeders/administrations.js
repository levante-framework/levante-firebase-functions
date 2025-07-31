const admin = require('firebase-admin');

// Administration templates with different task combinations
const ADMINISTRATION_TEMPLATES = [
  {
    templateId: 'reading-assessment-1',
    name: 'Basic Reading Assessment',
    publicName: 'Reading Skills Evaluation',
    taskIds: ['pa', 'sre', 'swr'],
    sequential: false,
    tags: ['reading', 'literacy', 'basic'],
    daysToClose: 30,
  },
  {
    templateId: 'cognitive-assessment-1',
    name: 'Cognitive Assessment Battery',
    publicName: 'Thinking Skills Assessment',
    taskIds: ['matrix-reasoning', 'mental-rotation', 'memory-game'],
    sequential: false,
    tags: ['cognitive', 'reasoning', 'memory'],
    daysToClose: 21,
  },
  {
    templateId: 'comprehensive-assessment-1',
    name: 'Comprehensive Academic Assessment',
    publicName: 'Complete Learning Evaluation',
    taskIds: ['vocab', 'egma-math', 'trog', 'theory-of-mind'],
    sequential: false,
    tags: ['comprehensive', 'academic', 'language'],
    daysToClose: 45,
  },
  {
    templateId: 'executive-function-assessment',
    name: 'Executive Function Assessment',
    publicName: 'Focus and Control Skills Test',
    taskIds: ['hearts-and-flowers', 'MEFS', 'same-different-selection'],
    sequential: false,
    tags: ['executive-function', 'attention', 'control'],
    daysToClose: 14,
  },
  {
    templateId: 'mixed-assessment-battery',
    name: 'Mixed Skills Assessment',
    publicName: 'General Skills Evaluation',
    taskIds: ['intro', 'pa', 'matrix-reasoning', 'vocab'],
    sequential: false,
    tags: ['mixed', 'general', 'evaluation'],
    daysToClose: 60,
  },
  {
    templateId: 'survey-administration',
    name: 'Background Survey',
    publicName: 'Background Information Survey',
    taskIds: ['survey'],
    sequential: true,
    tags: ['survey', 'background', 'information'],
    daysToClose: 90,
    userTypes: ['student', 'teacher', 'parent'], // For all participant types
  },
];

// Default legal information
const DEFAULT_LEGAL = {
  amount: '0',
  assent: null,
  consent: 'I consent to the terms of the Levante Privacy Policy and Terms of Service.',
  expectedTime: '30 minutes',
};

async function createAdministrations(adminApp, createdTasks, users, groups) {
  const db = adminApp.firestore();
  const createdAdministrations = [];

  console.log('  Creating administrations...');

  // Create organization references using the generated IDs
  const testOrgs = {
    districts: [groups.districts[0].id],
    schools: [groups.schools[0].id],
    classes: [groups.classes[0].id],
    groups: [groups.groups[0].id],
    families: [],
  };

  // Create a lookup map for task variants
  const taskVariantMap = {};
  createdTasks.forEach((task) => {
    taskVariantMap[task.id] = task.variantId;
  });

  // Get participant users (excluding admin users)
  const participantUsers = Object.entries(users).filter(([userKey, user]) =>
    ['student', 'parent', 'teacher'].includes(user.userType),
  );

  for (const template of ADMINISTRATION_TEMPLATES) {
    try {
      // Generate administration ID
      const administrationId = db.collection('administrations').doc().id;
      
      console.log(`    Creating administration: ${administrationId} (${template.name})...`);

      const now = new Date();
      const closeDate = new Date(now.getTime() + template.daysToClose * 24 * 60 * 60 * 1000);

      // Build assessments array from task IDs
      const assessments = template.taskIds.map((taskId) => {
        const variantId = taskVariantMap[taskId];
        if (!variantId) {
          throw new Error(`Variant not found for task: ${taskId}`);
        }

        return {
          conditions: {
            assigned: {},
            conditions: [],
          },
          params: getDefaultParamsForTask(taskId),
          taskName: taskId,
          taskId: taskId,
          variantId: variantId,
          variantName: getVariantNameForTask(taskId),
        };
      });

      // Create administration document
      const administrationData = {
        assessments: assessments,
        classes: testOrgs.classes,
        createdBy: users.admin.uid,
        dateClosed: admin.firestore.Timestamp.fromDate(closeDate),
        dateCreated: admin.firestore.FieldValue.serverTimestamp(),
        dateOpened: admin.firestore.Timestamp.fromDate(now),
        districts: testOrgs.districts,
        families: testOrgs.families,
        groups: testOrgs.groups,
        legal: DEFAULT_LEGAL,
        minimalOrgs: testOrgs,
        name: template.name,
        publicName: template.publicName,
        readOrgs: testOrgs,
        schools: testOrgs.schools,
        sequential: template.sequential,
        tags: template.tags,
        testData: true,
      };

      const adminRef = db.collection('administrations').doc(administrationId);
      await adminRef.set(administrationData);
      console.log(`      ✅ Created administration document: ${administrationId}`);

      // Create assignedOrgs subcollection
      await createAssignedOrgs(adminRef, administrationId, template, administrationData);

      // Create readOrgs subcollection
      await createReadOrgs(adminRef, administrationId, template, administrationData);

      // Create stats subcollection
      await createStats(adminRef, template);

      // Create user assignments
      await createUserAssignments(db, administrationId, template, administrationData, participantUsers, taskVariantMap);

      createdAdministrations.push({
        id: administrationId,
        templateId: template.templateId,
        name: template.name,
        publicName: template.publicName,
        taskCount: template.taskIds.length,
        sequential: template.sequential,
      });
    } catch (error) {
      console.error(`      ❌ Failed to create administration ${template.templateId}:`, error.message);
      throw error;
    }
  }

  console.log(`  ✅ Created ${createdAdministrations.length} administrations with subcollections`);
  return createdAdministrations;
}

async function createAssignedOrgs(adminRef, administrationId, template, administrationData) {
  console.log(`      Creating assignedOrgs subcollection...`);

  // Create assigned orgs for each organization type
  const orgTypes = ['districts', 'schools', 'classes', 'groups'];

  for (const orgType of orgTypes) {
    const orgIds = administrationData[orgType];

    for (const orgId of orgIds) {
      const assignedOrgData = {
        administrationId: administrationId,
        createdBy: administrationData.createdBy,
        dateClosed: administrationData.dateClosed,
        dateCreated: admin.firestore.FieldValue.serverTimestamp(),
        dateOpened: administrationData.dateOpened,
        legal: administrationData.legal,
        name: administrationData.name,
        orgId: orgId,
        orgType: orgType.slice(0, -1), // Remove 's' to match schema (e.g., 'districts' -> 'district')
        publicName: administrationData.publicName,
        testData: administrationData.testData,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      };

      const assignedOrgRef = adminRef.collection('assignedOrgs').doc();
      await assignedOrgRef.set(assignedOrgData);
    }
  }

  console.log(`      ✅ Created assignedOrgs subcollection`);
}

async function createReadOrgs(adminRef, administrationId, template, administrationData) {
  console.log(`      Creating readOrgs subcollection...`);

  // Create read orgs for each organization type
  const orgTypes = ['districts', 'schools', 'classes', 'groups'];

  for (const orgType of orgTypes) {
    const orgIds = administrationData[orgType];

    for (const orgId of orgIds) {
      const readOrgData = {
        administrationId: administrationId,
        createdBy: administrationData.createdBy,
        dateClosed: administrationData.dateClosed,
        dateCreated: admin.firestore.FieldValue.serverTimestamp(),
        dateOpened: administrationData.dateOpened,
        legal: administrationData.legal,
        name: administrationData.name,
        orgId: orgId,
        orgType: orgType.slice(0, -1), // Remove 's' to match schema
        publicName: administrationData.publicName,
        testData: administrationData.testData,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      };

      const readOrgRef = adminRef.collection('readOrgs').doc();
      await readOrgRef.set(readOrgData);
    }
  }

  console.log(`      ✅ Created readOrgs subcollection`);
}

async function createStats(adminRef, template) {
  console.log(`      Creating stats subcollection...`);

  // Create sample stats document
  const statsData = {
    assignment: {
      total: 0,
      started: 0,
      completed: 0,
      assigned: 0,
    },
    survey: {
      total: 0,
      completed: 0,
    },
  };

  const statsRef = adminRef.collection('stats').doc('summary');
  await statsRef.set(statsData);

  console.log(`      ✅ Created stats subcollection`);
}

async function createUserAssignments(db, administrationId, template, administrationData, participantUsers, taskVariantMap) {
  console.log(`      Creating user assignments...`);

  // Create testOrgs for assignments using the same IDs as the administration
  const testOrgs = {
    districts: administrationData.districts,
    schools: administrationData.schools,
    classes: administrationData.classes,
    groups: administrationData.groups,
    families: administrationData.families,
  };

  // Filter users based on administration's target user types
  const eligibleUsers = participantUsers.filter(([userKey, user]) => {
    if (template.userTypes) {
      // If administration specifies user types, only assign to those types
      return template.userTypes.includes(user.userType);
    } else {
      // If no user types specified, only assign to students (exclude teacher/parent from academic assessments)
      return user.userType === 'student';
    }
  });

  if (eligibleUsers.length === 0) {
    console.log(`      ⚠️  No eligible users for ${template.name}`);
    return;
  }

  for (const [userKey, user] of eligibleUsers) {
    try {
      // Build assessments array for assignment document
      const assessments = template.taskIds.map((taskId) => ({
        optional: false,
        taskId: taskId,
        variantId: taskVariantMap[taskId],
        variantName: getVariantNameForTask(taskId),
      }));

      // Create assignment document following Assignment interface
      const assignmentData = {
        assessments: assessments,
        assigningOrgs: testOrgs,
        completed: false,
        dateAssigned: admin.firestore.FieldValue.serverTimestamp(),
        dateOpened: administrationData.dateOpened,
        dateClosed: administrationData.dateClosed,
        id: administrationId,
        name: administrationData?.name,
        publicName: administrationData?.publicName,
        readOrgs: testOrgs,
        started: false,
        userData: {
          assessmentPid: user.uid,
          assessmentUid: user.uid,
          email: user.email,
          grade: null,
          name: {
            first: user.displayName.split(' ')[0] || '',
            middle: null,
            last: user.displayName.split(' ').slice(1).join(' ') || '',
          },
          schoolLevel: null,
          username: user.email.split('@')[0],
        },
      };

      // Create assignment document in user's assignments subcollection
      const assignmentRef = db.collection('users').doc(user.uid).collection('assignments').doc(administrationId);
      await assignmentRef.set(assignmentData);

      // Update user document to add administration ID to assignments.assigned array
      const userRef = db.collection('users').doc(user.uid);
      await userRef.update({
        'assignments.assigned': admin.firestore.FieldValue.arrayUnion(administrationId),
      });

      console.log(`        ✅ Created assignment for ${userKey} (${user.email})`);
    } catch (error) {
      console.error(`        ❌ Failed to create assignment for ${userKey}:`, error.message);
      throw error;
    }
  }

  console.log(`      ✅ Created assignments for ${eligibleUsers.length} users`);
}

function getDefaultParamsForTask(taskId) {
  // Return appropriate default parameters based on task type
  const readingTasks = ['pa', 'sre', 'swr'];
  const specialTasks = ['MEFS', 'survey'];

  if (readingTasks.includes(taskId)) {
    return {
      language: 'en',
      skipInstructions: true,
    };
  } else if (specialTasks.includes(taskId)) {
    return {};
  } else {
    // Standard tasks
    return {
      language: 'en',
      skipInstructions: true,
      keyHelpers: true,
      numOfPracticeTrials: 2,
      sequentialPractice: true,
      stimulusBlocks: 3,
    };
  }
}

function getVariantNameForTask(taskId) {
  // Return appropriate variant name based on task type
  const taskNames = {
    pa: 'Phonological Awareness - English',
    sre: 'Sentence Reading Efficiency - English',
    swr: 'Sight Word Reading - English',
    'matrix-reasoning': 'Matrix Reasoning - English',
    'mental-rotation': 'Mental Rotation - English',
    intro: 'Introduction - English',
    'memory-game': 'Memory Game - English',
    'hearts-and-flowers': 'Hearts and Flowers - English',
    'egma-math': 'EGMA Math - English',
    trog: 'TROG - English',
    'theory-of-mind': 'Theory of Mind - English',
    vocab: 'Vocabulary - English',
    'same-different-selection': 'Same Different Selection - English',
    MEFS: 'MEFS - All Languages',
    survey: 'Survey - All Languages',
  };

  return taskNames[taskId] || `${taskId} - English`;
}

module.exports = { createAdministrations };
