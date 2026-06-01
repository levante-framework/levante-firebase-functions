const admin = require('firebase-admin');

function getUserClass(user) {
  // New class: ~100 students (student1–100) + 1 parent
  // Original class: teacher + standard student + student101–200
  if (user.userType === 'parent') return 'newClass';
  if (user.userType === 'teacher') return 'originalClass';
  if (user.userType === 'student') {
    const match = user.email.match(/^student(\d+)@levante\.test$/);
    if (match) {
      const num = parseInt(match[1], 10);
      return num <= 100 ? 'newClass' : 'originalClass';
    }
    return 'originalClass'; // standard student@levante.test
  }
  return 'originalClass';
}

async function linkUsersToGroups(adminApp, users, groups) {
  const db = adminApp.firestore();
  
  console.log("  Linking users to groups...");
  
  const districtId = groups.districts[0].id;
  const schoolId = groups.schools[0].id;
  const classId = groups.classes[0].id; // original: 3rd Grade - Room 101
  const classId2 = groups.classes[1].id; // new: 4th Grade - Room 102
  const groupId = groups.groups[0].id;
  
  const participantUsers = users.filter((user) => 
    ['student', 'parent', 'teacher'].includes(user.userType)
  );
  
  for (const user of participantUsers) {
    try {
      const userClass = getUserClass(user);
      const assignedClassId = userClass === 'newClass' ? classId2 : classId;
      
      console.log(`    Linking ${user.email} to groups (${userClass === 'newClass' ? '4th Grade' : '3rd Grade'})...`);
      
      const currentTimestamp = admin.firestore.FieldValue.serverTimestamp();
      
      const userRef = db.collection('users').doc(user.uid);
      
      const updateData = {
        'districts.all': admin.firestore.FieldValue.arrayUnion(districtId),
        'districts.current': admin.firestore.FieldValue.arrayUnion(districtId),
        [`districts.dates.${districtId}`]: currentTimestamp,
        'schools.all': admin.firestore.FieldValue.arrayUnion(schoolId),
        'schools.current': admin.firestore.FieldValue.arrayUnion(schoolId),
        [`schools.dates.${schoolId}`]: currentTimestamp,
        'classes.all': admin.firestore.FieldValue.arrayUnion(assignedClassId),
        'classes.current': admin.firestore.FieldValue.arrayUnion(assignedClassId),
        [`classes.dates.${assignedClassId}`]: currentTimestamp,
        'groups.all': admin.firestore.FieldValue.arrayUnion(groupId),
        'groups.current': admin.firestore.FieldValue.arrayUnion(groupId),
        [`groups.dates.${groupId}`]: currentTimestamp,
      };
      
      await userRef.update(updateData);
      
      console.log(`      ✅ Linked ${user.email} (district, school, class ${assignedClassId}, group)`);
      
    } catch (error) {
      console.error(`      ❌ Failed to link ${user.email} to groups:`, error.message);
      throw error;
    }
  }
  
  console.log("  All participant users linked to groups successfully");
}

module.exports = { linkUsersToGroups }; 
