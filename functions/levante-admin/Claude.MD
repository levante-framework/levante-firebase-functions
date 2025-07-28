# LEVANTE Admin Firebase Functions

This project contains Firebase Cloud Functions for the LEVANTE platform, which manages users, organizations, administrations, and assessments.

## Project Overview

The LEVANTE admin functions handle:
- User management (creation, editing, deletion, authentication)
- Organization hierarchy (districts, schools, classes, groups, families)
- Administration management (assessment configurations)
- Assignment synchronization (user-specific assessment instances)
- Run tracking (assessment completion tracking)
- Survey response collection

## Key Architecture Concepts

### Database Structure
- **Admin Database**: Contains all data
- Separate databases for production, and development environments
- Ignore any references to the assessment database, it is being deprecated.

### Organization Hierarchy
```
Districts
  └── Schools
      └── Classes
      └── Groups
```

### Core Entities
- **Users**: Students, parents, teachers, and administrators
- **Administrations**: Assessment configurations with conditions and parameters
- **Assignments**: User-specific instances of administrations
- **Runs**: Individual assessment attempts and completions

## Main Functions

### User Management
- `createUsers`: Bulk create users with organization assignments
- `editUsers`: Update user information and organization memberships
- `linkUsers`: Connect related users (e.g., students to parents)
- `createAdministratorAccount`: Create admin users with specific permissions
- `setUidClaims`: Set custom authentication claims for users
- `appendToAdminClaims`/`removeFromAdminClaims`: Manage admin organization permissions

### Organization Management
- `upsertOrg`: Create or update organizations in the hierarchy
- `deleteOrgFunction`: Delete organizations with optional recursive deletion
- `unenrollOrgTask`: Remove organization from administrations (background task)

### Administration Management
- `upsertAdministration`: Create or update assessment administrations
- `deleteAdministration`: Delete administrations (super admin only)
- `getAdministrations`: Retrieve administrations for an administrator
- `syncAssignmentsOnAdministrationUpdate`: Sync assignments when administration changes

### Assignment Synchronization
- `syncAssignmentCreated`: Mirror assignment creation to assessment database
- `syncAssignmentUpdated`: Sync assignment updates
- `syncAssignmentDeleted`: Handle assignment deletion
- `syncAssignmentsOnUserUpdate`: Update assignments when user data changes
- `updateAssignmentsForOrgChunk`: Background task for bulk assignment updates

### Assessment Tracking
- `startTask`: Initialize assessment task
- `completeTask`: Mark assessment task as complete
- `syncOnRunDocUpdate`: Update best run and completion status
- `saveSurveyResponses`: Store survey responses from assessments

### Soft Delete Functions
- `softDeleteUser`: Mark user as deleted without removing data
- `softDeleteUserAssignment`: Soft delete user assignments
- `softDeleteUserExternalData`: Soft delete external user data

## Development Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Watch mode for development
npm run build:watch

# Format code
npm run format

# Lint check
npm run lint

# Deploy to development
npm run deploy:dev

# Deploy to production
npm run deploy:prod

# Start local emulators
npm run serve

# View function logs
npm run logs

# Validate Firestore indexes
npm run validate:indexes

```

## Security & Permissions

- All functions require authentication via Firebase Auth
- Custom claims system for role-based access control
- Super admin privileges required for certain operations (e.g., deleting administrations)
- Organization-based permissions for data access

## Error Handling

Functions use Firebase's `HttpsError` with standard error codes:
- `unauthenticated`: User not authenticated
- `permission-denied`: Insufficient permissions
- `invalid-argument`: Invalid input parameters
- `internal`: Server-side errors

## Performance Considerations

- Functions use increased memory (512MiB - 2GiB) for data-intensive operations
- Background tasks with retry configuration for reliability
- Rate limiting on concurrent task dispatches
- Timeout settings up to 540 seconds for long-running operations

## Testing

The project uses TypeScript for type safety. Ensure all code passes:
- TypeScript compilation (`npm run build`)
- Prettier formatting (`npm run lint`)

## License

Stanford Academic Software License for LEVANTE
