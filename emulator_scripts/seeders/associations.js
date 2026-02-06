const admin = require('firebase-admin');

async function linkUsersToGroups(adminApp, users, groups) {
  const db = adminApp.firestore();

  console.log('  Linking users to groups...');

  // Extract the first (and only) IDs from each group type
  const districtId = groups.districts[0].id;
  const schoolId = groups.schools[0].id;
  const schoolId2 = groups.schools[1]?.id;
  const classId = groups.classes[0].id;
  const classId2 = groups.classes[1]?.id;
  const groupId = groups.groups[0].id;

  // Get participant users (exclude admin users)
  const participantUsers = Object.entries(users).filter(([userKey, user]) =>
    ['student', 'parent', 'teacher'].includes(user.userType),
  );

  for (const [userKey, user] of participantUsers) {
    try {
      console.log(`    Linking ${userKey} to groups...`);

      const currentTimestamp = admin.firestore.FieldValue.serverTimestamp();

      // Update user document with group associations
      const userRef = db.collection('users').doc(user.uid);

      const updateData = {
        // Add to districts
        'districts.all': admin.firestore.FieldValue.arrayUnion(districtId),
        'districts.current': admin.firestore.FieldValue.arrayUnion(districtId),
        [`districts.dates.${districtId}`]: { from: currentTimestamp, to: null },

        // Add to schools
        'schools.all': admin.firestore.FieldValue.arrayUnion(schoolId),
        'schools.current': admin.firestore.FieldValue.arrayUnion(schoolId),
        [`schools.dates.${schoolId}`]: { from: currentTimestamp, to: null },

        // Add to classes
        'classes.all': admin.firestore.FieldValue.arrayUnion(classId),
        'classes.current': admin.firestore.FieldValue.arrayUnion(classId),
        [`classes.dates.${classId}`]: { from: currentTimestamp, to: null },

        // Add to groups
        'groups.all': admin.firestore.FieldValue.arrayUnion(groupId),
        'groups.current': admin.firestore.FieldValue.arrayUnion(groupId),
        [`groups.dates.${groupId}`]: { from: currentTimestamp, to: null },
      };

      await userRef.update(updateData);

      if (userKey === 'teacher2' && schoolId2 && classId2) {
        await userRef.update({
          'schools.all': admin.firestore.FieldValue.arrayUnion(schoolId2),
          'schools.current': [schoolId],
          [`schools.dates.${schoolId}`]: { from: currentTimestamp, to: null },
          [`schools.dates.${schoolId2}`]: { from: currentTimestamp, to: currentTimestamp },
          'classes.all': admin.firestore.FieldValue.arrayUnion(classId2),
          'classes.current': [classId],
          [`classes.dates.${classId}`]: { from: currentTimestamp, to: null },
          [`classes.dates.${classId2}`]: { from: currentTimestamp, to: currentTimestamp },
        });
      }

      console.log(`      ✅ Linked ${userKey} to groups`);
      console.log(`        - Districts: ${districtId}`);
      console.log(`        - Schools: ${schoolId}`);
      console.log(`        - Classes: ${classId}`);
      console.log(`        - Groups: ${groupId}`);
    } catch (error) {
      console.error(`      ❌ Failed to link ${userKey} to groups:`, error.message);
      throw error;
    }
  }

  // Link parent + teacher to student with link maps
  try {
    const studentUid = users.student?.uid;
    const teacherUid = users.teacher?.uid;
    const teacherUid2 = users.teacher2?.uid;
    const parentUid = users.parent?.uid;
    const parentUid2 = users.parent2?.uid;

    if (studentUid && teacherUid && parentUid) {
      const linkTimestamp = admin.firestore.FieldValue.serverTimestamp();
      const studentRef = db.collection('users').doc(studentUid);
      const teacherRef = db.collection('users').doc(teacherUid);
      const parentRef = db.collection('users').doc(parentUid);

      await studentRef.update({
        teacherLinks: {
          all: [teacherUid, teacherUid2].filter(Boolean),
          current: [teacherUid].filter(Boolean),
          dates: {
            ...(teacherUid ? { [teacherUid]: { from: linkTimestamp, to: null } } : {}),
            ...(teacherUid2 ? { [teacherUid2]: { from: linkTimestamp, to: linkTimestamp } } : {}),
          },
        },
        parentLinks: {
          all: [parentUid, parentUid2].filter(Boolean),
          current: [parentUid].filter(Boolean),
          dates: {
            ...(parentUid ? { [parentUid]: { from: linkTimestamp, to: null } } : {}),
            ...(parentUid2 ? { [parentUid2]: { from: linkTimestamp, to: linkTimestamp } } : {}),
          },
        },
        teacherIds: [teacherUid].filter(Boolean),
        parentIds: [parentUid].filter(Boolean),
      });

      await teacherRef.update({
        childLinks: {
          all: [studentUid],
          current: [studentUid],
          dates: { [studentUid]: { from: linkTimestamp, to: null } },
        },
        childIds: [studentUid],
      });

      if (teacherUid2) {
        await db
          .collection('users')
          .doc(teacherUid2)
          .update({
            childLinks: {
              all: [studentUid],
              current: [],
              dates: { [studentUid]: { from: linkTimestamp, to: linkTimestamp } },
            },
            childIds: [],
          });
      }

      await parentRef.update({
        childLinks: {
          all: [studentUid],
          current: [studentUid],
          dates: { [studentUid]: { from: linkTimestamp, to: null } },
        },
        childIds: [studentUid],
      });

      if (parentUid2) {
        await db
          .collection('users')
          .doc(parentUid2)
          .update({
            childLinks: {
              all: [studentUid],
              current: [],
              dates: { [studentUid]: { from: linkTimestamp, to: linkTimestamp } },
            },
            childIds: [],
          });
      }
      console.log('      ✅ Linked student to teacher and parent');
    }
  } catch (error) {
    console.error('      ❌ Failed to link student to teacher/parent:', error.message);
    throw error;
  }

  console.log('  All participant users linked to groups successfully');
}

module.exports = { linkUsersToGroups };
