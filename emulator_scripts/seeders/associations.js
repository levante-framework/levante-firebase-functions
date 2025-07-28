const admin = require('firebase-admin');

async function linkUsersToGroups(adminApp, users, groups) {
  const db = adminApp.firestore();
  
  console.log("  Linking users to groups...");
  
  // Extract the first (and only) IDs from each group type
  const districtId = groups.districts[0].id;
  const schoolId = groups.schools[0].id;
  const classId = groups.classes[0].id;
  const groupId = groups.groups[0].id;
  
  // Get participant users (exclude admin users)
  const participantUsers = Object.entries(users).filter(([userKey, user]) => 
    ['student', 'parent', 'teacher'].includes(user.userType)
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
        [`districts.dates.${districtId}`]: currentTimestamp,
        
        // Add to schools
        'schools.all': admin.firestore.FieldValue.arrayUnion(schoolId),
        'schools.current': admin.firestore.FieldValue.arrayUnion(schoolId),
        [`schools.dates.${schoolId}`]: currentTimestamp,
        
        // Add to classes
        'classes.all': admin.firestore.FieldValue.arrayUnion(classId),
        'classes.current': admin.firestore.FieldValue.arrayUnion(classId),
        [`classes.dates.${classId}`]: currentTimestamp,
        
        // Add to groups
        'groups.all': admin.firestore.FieldValue.arrayUnion(groupId),
        'groups.current': admin.firestore.FieldValue.arrayUnion(groupId),
        [`groups.dates.${groupId}`]: currentTimestamp,
      };
      
      await userRef.update(updateData);
      
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
  
  console.log("  All participant users linked to groups successfully");
}

module.exports = { linkUsersToGroups }; 
