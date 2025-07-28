const admin = require('firebase-admin');
const { normalizeToLowercase } = require('../../helpers/index.js');

async function createGroups(adminApp, createdBy) {
  const db = adminApp.firestore();

  console.log('  Creating districts...');

  // Generate district ID
  const districtId = db.collection('districts').doc().id;
  
  // Generate school ID
  const schoolId = db.collection('schools').doc().id;
  
  // Generate class ID  
  const classId = db.collection('classes').doc().id;
  
  // Generate group ID
  const groupId = db.collection('groups').doc().id;

  // Create test district
  const districtData = {
    archived: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: createdBy,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    name: 'Test District',
    normalizedName: normalizeToLowercase('Test District'),
    tags: ['test', 'levante'],
    subGroups: [groupId],
    schools: [schoolId],
  };

  const districtRef = db.collection('districts').doc(districtId);
  await districtRef.set(districtData);
  console.log(`    ✅ Created district: ${districtId}`);
  console.log('  Creating schools...');

  // Create test school
  const schoolData = {
    archived: false,
    classes: [classId],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: createdBy,
    districtId: districtId,
    id: schoolId,
    name: 'Test Elementary School',
    normalizedName: normalizeToLowercase('Test Elementary School'),
  };

  const schoolRef = db.collection('schools').doc(schoolId);
  await schoolRef.set(schoolData);
  console.log(`    ✅ Created school: ${schoolId}`);

  console.log('  Creating classes...');

  // Create test class
  const classData = {
    archived: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: createdBy,
    districtId: districtId,
    id: classId,
    name: '3rd Grade - Room 101',
    normalizedName: normalizeToLowercase('3rd Grade - Room 101'),
    schoolId: schoolId,
  };

  const classRef = db.collection('classes').doc(classId);
  await classRef.set(classData);
  console.log(`    ✅ Created class: ${classId}`);

  console.log('  Creating groups...');

  // Create test group (cohort)
  const groupData = {
    archived: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: createdBy,
    parentOrgId: districtId,
    parentOrgType: 'district',
    name: 'Reading Intervention Cohort',
    normalizedName: normalizeToLowercase('Reading Intervention Cohort'),
    tags: ['intervention', 'reading', 'cohort'],
  };

  const groupRef = db.collection('groups').doc(groupId);
  await groupRef.set(groupData);
  console.log(`    ✅ Created group: ${groupId}`);

  return {
    districts: [{ id: districtId, name: 'Test District' }],
    schools: [{ id: schoolId, name: 'Test Elementary School', districtId: districtId }],
    classes: [
      { id: classId, name: '3rd Grade - Room 101', schoolId: schoolId, districtId: districtId },
    ],
    groups: [{ id: groupId, name: 'Reading Intervention Cohort', parentOrgId: districtId }],
  };
}

module.exports = { createGroups };
