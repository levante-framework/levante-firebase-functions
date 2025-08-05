const admin = require('firebase-admin');

// // Point to the emulator BEFORE initializing Firebase Admin
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8180";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9199";

// Initialize Firebase Admin with the emulator configuration
const adminApp = admin.initializeApp({projectId: "demo-emulator"}, "admin-seeder");

// Import seeding modules
const { createGroups } = require('./seeders/groups');
const { createUsers } = require('./seeders/users');
const { createUserClaims } = require('./seeders/userClaims');
const { linkUsersToGroups } = require('./seeders/associations');
const { updateUserRoles } = require('./seeders/roles');
const { createTasks } = require('./seeders/tasks');
const { createAdministrations } = require('./seeders/administrations');

async function seedDatabase() {
  try {
    console.log("=== STARTING DATABASE SEEDING ===\n");
    
    // Step 1: Create Auth users and user documents
    console.log("Step 1: Creating users...");
    const users = await createUsers(adminApp);
    console.log("✅ Users created successfully\n");

    // Step 2: Create groups (districts, schools, classes, groups)
    console.log("Step 2: Creating groups...");
    const groups = await createGroups(adminApp, users.admin.uid);
    console.log("✅ Groups created successfully\n");
    
    // Step 3: Create userClaims documents
    console.log("Step 3: Creating user claims...");
    await createUserClaims(adminApp, users, groups);
    console.log("✅ User claims created successfully\n");
    
    // Step 4: Link users to groups
    console.log("Step 4: Linking users to groups...");
    await linkUsersToGroups(adminApp, users, groups);
    console.log("✅ User-group associations created successfully\n");
    
    // Step 5: Update user roles based on associations
    console.log("Step 5: Updating user roles...");
    await updateUserRoles(adminApp, users, groups);
    console.log("✅ User roles updated successfully\n");
    
    // Step 6: Create tasks and variants
    console.log("Step 6: Creating tasks and variants...");
    const tasks = await createTasks(adminApp);
    console.log("✅ Tasks and variants created successfully\n");
    
    // Step 7: Create administrations with subcollections
    console.log("Step 7: Creating administrations...");
    const administrations = await createAdministrations(adminApp, tasks, users, groups);
    console.log("✅ Administrations created successfully\n");
    
    console.log("=== DATABASE SEEDING COMPLETE ===");
    console.log("\nCreated data summary:");
    console.log(`- Districts: ${groups.districts.length}`);
    console.log(`- Schools: ${groups.schools.length}`);
    console.log(`- Classes: ${groups.classes.length}`);
    console.log(`- Groups: ${groups.groups.length}`);
    console.log(`- Users: ${Object.keys(users).length}`);
    console.log(`- Tasks: ${tasks.length}`);
    console.log(`- Administrations: ${administrations.length}`);
    
    console.log("\nUser credentials:");
    Object.entries(users).forEach(([type, user]) => {
      console.log(`- ${type}: ${user.email} (password: ${user.password})`);
    });
    
    console.log("\nCreated administrations:");
    administrations.forEach(admin => {
      console.log(`- ${admin.name} (${admin.taskCount} tasks, ${admin.sequential ? 'sequential' : 'parallel'})`);
    });
    
    const studentCount = Object.values(users).filter(user => user.userType === 'student').length;
    const allParticipantCount = Object.values(users).filter(user => 
      ['student', 'teacher', 'parent'].includes(user.userType)
    ).length;
    console.log(`\nAssignment distribution:`);
    console.log(`- Academic assessments assigned to ${studentCount} student(s)`);
    console.log(`- Survey administration assigned to ${allParticipantCount} participant(s) (students, teachers, parents)`);
    
    console.log("\n=== READY FOR TESTING ===");
    
  } catch (error) {
    console.error("\n❌ SEEDING FAILED!");
    console.error("Error:", error.message);
    if (error.stack) {
      console.error("Stack trace:", error.stack);
    }
    throw error;
  }
}

// Run the seeding process
seedDatabase(); 
