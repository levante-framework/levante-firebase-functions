const admin = require('firebase-admin');

const ADULT_TASK_IDS = ['adult-reasoning', 'caregiver-survey', 'teacher-survey'];
const MAX_CHILD_BUNDLES = 3;

const DEFAULT_LEGAL = {
  amount: '0',
  assent: null,
  consent: 'I consent to the terms of the Levante Privacy Policy and Terms of Service.',
  expectedTime: '30 minutes',
};

async function pickFirstVariantAssessment(db, taskId) {
  const taskRef = db.collection('tasks').doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    return null;
  }
  const variantsSnap = await taskRef.collection('variants').get();
  if (variantsSnap.empty) {
    return null;
  }
  const docs = [...variantsSnap.docs].sort((a, b) => a.id.localeCompare(b.id));
  const v = docs[0];
  const d = v.data() || {};
  const variantName =
    typeof d.name === 'string' && d.name.trim() !== '' ? d.name.trim() : String(v.id);
  const params =
    d.params != null && typeof d.params === 'object' && !Array.isArray(d.params)
      ? { ...d.params }
      : getDefaultParamsForTask(taskId);
  return {
    taskId,
    variantId: v.id,
    variantName,
    params,
  };
}

function splitTaskIdsIntoNBuckets(taskIds, n) {
  if (!taskIds.length || n < 1) {
    return [];
  }
  const num = Math.min(n, taskIds.length);
  const chunks = [];
  let index = 0;
  for (let b = 0; b < num; b++) {
    const remaining = taskIds.length - index;
    const bucketsLeft = num - b;
    const size = Math.ceil(remaining / bucketsLeft);
    chunks.push(taskIds.slice(index, index + size));
    index += size;
  }
  return chunks;
}

async function buildAdministrationPlans(db) {
  const tasksSnap = await db.collection('tasks').get();
  if (tasksSnap.empty) {
    throw new Error('No tasks in Firestore; seed tasks before administrations.');
  }
  const allTaskIds = tasksSnap.docs.map((d) => d.id).sort((a, b) => a.localeCompare(b));

  const plans = [];

  const adultAssessments = [];
  for (const id of ADULT_TASK_IDS) {
    const a = await pickFirstVariantAssessment(db, id);
    if (!a) {
      adultAssessments.length = 0;
      break;
    }
    adultAssessments.push(a);
  }

  const adultAssignmentReady = adultAssessments.length === ADULT_TASK_IDS.length;
  if (adultAssignmentReady) {
    plans.push({
      template: {
        templateId: 'adult-task-assignment',
        name: 'Adult Task Assignment',
        publicName: 'Adult Task Assignment',
        sequential: false,
        tags: ['adult', 'emulator'],
        daysToClose: 30,
        userTypes: ['student', 'teacher', 'parent'],
      },
      assessments: adultAssessments,
    });
  } else if (adultAssessments.length > 0) {
    console.warn(
      `[seed] Skipping "Adult Task Assignment": need a variant for each of ${ADULT_TASK_IDS.join(', ')}.`,
    );
  }

  const adultIdSet = new Set(ADULT_TASK_IDS);
  const childTaskIds = allTaskIds.filter((id) => !adultAssignmentReady || !adultIdSet.has(id));

  const numBundles = Math.min(MAX_CHILD_BUNDLES, childTaskIds.length);
  const chunks = splitTaskIdsIntoNBuckets(childTaskIds, numBundles);
  for (let i = 0; i < chunks.length; i++) {
    const ids = chunks[i];
    const assessments = [];
    for (const taskId of ids) {
      const a = await pickFirstVariantAssessment(db, taskId);
      if (a) {
        assessments.push(a);
      }
    }
    if (assessments.length === 0) {
      continue;
    }
    const n = i + 1;
    plans.push({
      template: {
        templateId: `task-bundle-${n}`,
        name: `Task Bundle ${n}`,
        publicName: `Task Bundle ${n}`,
        sequential: false,
        tags: ['child', 'emulator'],
        daysToClose: 30,
      },
      assessments,
    });
  }

  return plans;
}

async function createAdministrations(adminApp, users, groups) {
  const db = adminApp.firestore();
  const createdAdministrations = [];

  console.log('  Creating administrations from seeded tasks/variants...');

  const testOrgs = {
    districts: [groups.districts[0].id],
    schools: [groups.schools[0].id],
    classes: groups.classes.map((c) => c.id),
    groups: [groups.groups[0].id],
    families: [],
  };

  const participantUsers = users.filter((user) =>
    ['student', 'parent', 'teacher'].includes(user.userType),
  );

  const plans = await buildAdministrationPlans(db);
  if (plans.length === 0) {
    throw new Error('No administrations could be built from Firestore tasks (no variants?).');
  }

  const adminUser = users.find((user) => user.userKey === 'admin');

  for (const plan of plans) {
    const { template, assessments } = plan;
    try {
      const administrationId = db.collection('administrations').doc().id;

      console.log(`    Creating administration: ${administrationId} (${template.name})...`);

      const now = new Date();
      const closeDate = new Date(now.getTime() + template.daysToClose * 24 * 60 * 60 * 1000);

      const administrationData = {
        assessments,
        classes: testOrgs.classes,
        createdBy: adminUser.uid,
        creatorName: adminUser.displayName,
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
        testData: false,
        siteId: testOrgs.districts[0],
      };

      const adminRef = db.collection('administrations').doc(administrationId);
      await adminRef.set(administrationData);
      console.log(`      ✅ Created administration document: ${administrationId}`);

      await createAssignedOrgs(adminRef, administrationId, template, administrationData);

      await createReadOrgs(adminRef, administrationId, template, administrationData);

      await createStats(adminRef, template);

      await createUserAssignments(
        adminApp,
        db,
        administrationId,
        template,
        administrationData,
        participantUsers,
      );

      createdAdministrations.push({
        id: administrationId,
        templateId: template.templateId,
        name: template.name,
        publicName: template.publicName,
        taskCount: assessments.length,
        sequential: template.sequential,
      });
    } catch (error) {
      console.error(`      ❌ Failed to create administration ${template.templateId}:`, error.message);
      throw error;
    }
  }

  console.log(`  ✅ Created ${createdAdministrations.length} administration(s) with subcollections`);
  return createdAdministrations;
}

async function createAssignedOrgs(adminRef, administrationId, template, administrationData) {
  console.log(`      Creating assignedOrgs subcollection...`);

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
        orgType: orgType.slice(0, -1),
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
        orgType: orgType.slice(0, -1),
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

async function createUserAssignments(
  adminApp,
  db,
  administrationId,
  template,
  administrationData,
  participantUsers,
) {
  console.log(`      Creating user assignments...`);

  const testOrgs = {
    districts: administrationData.districts,
    schools: administrationData.schools,
    classes: administrationData.classes,
    groups: administrationData.groups,
    families: administrationData.families,
  };

  const eligibleUsers = participantUsers.filter((user) => {
    if (template.userTypes) {
      return template.userTypes.includes(user.userType);
    }
    return user.userType === 'student';
  });

  if (eligibleUsers.length === 0) {
    console.log(`      ⚠️  No eligible users for ${template.name}`);
    return;
  }

  const assignmentAssessments = administrationData.assessments.map((a) => ({
    optional: false,
    taskId: a.taskId,
    params: a.params,
    variantId: a.variantId,
    variantName: a.variantName,
  }));

  for (const user of eligibleUsers) {
    try {
      const assignmentData = {
        assessments: assignmentAssessments,
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

      const assignmentRef = db
        .collection('users')
        .doc(user.uid)
        .collection('assignments')
        .doc(administrationId);
      await assignmentRef.set(assignmentData);

      console.log(`        ✅ Created assignment for ${user.userKey} (${user.email})`);
    } catch (error) {
      console.error(`        ❌ Failed to create assignment for ${user.email}:`, error.message);
      throw error;
    }
  }

  console.log(`      ✅ Created assignments for ${eligibleUsers.length} users`);
}

function getDefaultParamsForTask(taskId) {
  const readingTasks = ['pa', 'sre', 'swr'];

  if (readingTasks.includes(taskId)) {
    return {
      language: 'en',
      skipInstructions: true,
    };
  }
  return {
    language: 'en',
    skipInstructions: true,
    keyHelpers: true,
    numOfPracticeTrials: 2,
    sequentialPractice: true,
    stimulusBlocks: 3,
  };
}

module.exports = { createAdministrations };
