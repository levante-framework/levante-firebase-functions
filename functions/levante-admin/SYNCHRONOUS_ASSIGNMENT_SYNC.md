# Synchronous Assignment Sync

## Overview

This document explains the changes made to eliminate the delay between creating/editing an assignment and displaying it on the home page. Previously, assignment creation/updates triggered background Firebase functions that processed assignments asynchronously, causing users to not see their newly created or edited assignments immediately.

## Problem

When a user created or edited an assignment via `upsertAdministration`:

1. The administration document was created/updated in Firestore
2. A Firestore trigger (`syncAssignmentsOnAdministrationUpdate`) was fired asynchronously
3. This trigger processed assignments in the background using task queues
4. Users were redirected to the home page before assignments were visible
5. This created a poor user experience with a noticeable delay

## Solution

The solution implements **fully synchronous and atomic assignment processing** within the `upsertAdministration` handler. **All assignment operations are processed synchronously** before the function returns, ensuring immediate visibility of assignments. The system also implements comprehensive atomic rollback - if any participant fails to receive an assignment, the entire operation is rolled back, including the administration document for new administrations.

## Implementation Details

### Architecture

The implementation processes **all org chunks synchronously** within the `upsertAdministration` handler:

1. **Synchronous Processing**: All org chunks are processed synchronously before the function returns
2. **Background Processing (Redundant)**: The existing Firestore trigger still fires and processes chunks asynchronously, but this is redundant since all chunks are already processed synchronously. The background processing is safe due to idempotent operations but adds unnecessary overhead.

### Code Structure

The synchronous sync logic is implemented as two helper functions within `upsertAdministration.ts`:

- `createAssignments` - Handles new administration creation
- `updateAssignments` - Handles administration updates

These functions are called directly after the Firestore transaction completes, ensuring assignments are processed before the function returns to the client.

### Key Functions

#### `createAssignments`

Handles synchronous assignment creation for new administrations:

```typescript
const createAssignments = async (
  administrationId: string,
  administrationDocRef: DocumentReference,
  currData: IAdministration,
  creatorUid?: string,
  isNewAdministration: boolean = false
)
```

**Process:**

1. Standardizes administration orgs using `standardizeAdministrationOrgs`
2. Chunks orgs into groups of 100
3. Processes **all chunks synchronously** using `updateAssignmentsForOrgChunkHandler`
4. Tracks all successfully created assignments in `allCreatedUserIds` for rollback if any chunk fails
5. If any chunk fails, immediately rolls back all previously processed chunks
6. If this is a new administration and any chunk fails, also rolls back the administration document
7. Re-throws errors to ensure the function fails if assignment creation fails

#### `updateAssignments`

Handles synchronous assignment updates for modified administrations:

```typescript
const updateAssignments = async (
  administrationId: string,
  administrationDocRef: DocumentReference,
  prevData: IAdministration,
  currData: IAdministration
)
```

**Process:**

1. Calculates removed orgs by comparing previous and current org lists
2. Removes assignments from users in removed orgs
3. Standardizes administration orgs
4. Processes **all org chunks synchronously** for updates
5. If any chunk fails, throws an error (errors are caught by the handler and logged but not re-thrown for updates)

### Modified Flow

**Before:**

```
upsertAdministration → Transaction → Return
                                      ↓
                    Firestore Trigger (async) → Process Assignments
```

**After:**

```
upsertAdministration → Transaction → Sync All Assignments (sync, atomic) → Return
                                      ↓
                    Firestore Trigger (async) → Process All Chunks (redundant, idempotent)
```

The synchronous sync is **fully atomic** - if any participant fails to receive an assignment, the entire operation (including the administration document for new administrations) is rolled back before the function returns. All chunks are processed synchronously, so the background trigger is redundant but safe due to idempotent operations.

### Implementation Details

The synchronous sync happens immediately after the transaction commits:

1. The administration document is fetched from Firestore (to ensure server timestamps are populated)
2. Based on whether it's a create or update operation, the appropriate sync function is called
3. The sync function processes **all org chunks synchronously**
4. The function returns, allowing the client to see all assignments immediately
5. The background trigger still fires but is redundant since all chunks are already processed

### Integration with Background Trigger

The background Firestore trigger (`syncAssignmentsOnAdministrationUpdate`) still fires after document writes, but it is **redundant** since all chunks are already processed synchronously:

- **Idempotent Operations**: All assignment operations are idempotent, so duplicate processing is safe
- **Redundant Processing**: The background trigger processes all chunks again, which is unnecessary overhead
- **Future Optimization**: Consider disabling or skipping the background trigger when all chunks have been processed synchronously to reduce unnecessary processing

## Configuration

### Synchronous Processing

The implementation processes **all org chunks synchronously**, where each chunk contains up to **100 organizations**. This ensures:

- **Immediate Visibility**: Users see all assignments immediately, regardless of scale
- **Complete Atomicity**: All participants receive assignments or none do (for new administrations)
- **No Partial States**: Eliminates the need for background processing to complete assignments

**Note**: For very large assignments (hundreds of chunks), this may approach Cloud Functions timeout limits. Monitor function execution times and consider implementing chunk processing limits if timeout issues occur.

## Transactional Guarantees

The assignment creation process implements **all-or-nothing semantics** to ensure data integrity:

### All-or-Nothing Behavior

When creating assignments for participants, the system guarantees that **all participants receive the assignment, or none do**. This prevents partial assignment states where some participants have assignments while others do not.

### Rollback Mechanism

If assignment creation fails for **any** participant in any chunk:

1. **Automatic Rollback**: The system automatically calls `rollbackAssignmentCreation` to revert all assignment-related changes
2. **Assignment Deletion**: All assignment documents created during the process are deleted
3. **User Document Reversion**: The administration ID is removed from user documents' `assignments` arrays
4. **Statistics Reversion**: Any administration statistics that were incremented are decremented
5. **Administration Document Rollback** (for new administrations only): If this is a new administration, the system also calls `rollbackAdministrationCreation` to:
   - Delete the administration document from the `administrations` collection
   - Remove the administration ID from the creator's `adminData.administrationsCreated` array
6. **Error Propagation**: The error is thrown, causing the entire `upsertAdministration` operation to fail

### Rollback Implementation

The rollback process consists of two functions:

**`rollbackAssignmentCreation`** (in `assignment-utils.ts`):

- Processes rollbacks in batches of up to 500 operations for efficiency
- Deletes assignment documents from the `users/{userId}/assignments/{administrationId}` subcollection
- Removes the administration ID from user documents' `assignments.assigned` array
- Deletes the `assignmentsAssigned.{administrationId}` timestamp field
- Decrements administration statistics if org chunk and administration data are provided

**`rollbackAdministrationCreation`** (in `assignment-utils.ts`):

- Used only for new administrations when assignment creation fails
- Deletes the administration document from the `administrations` collection
- Removes the administration ID from the creator's `adminData.administrationsCreated` array
- Uses a Firestore transaction to ensure atomicity

### Chunk-Level Rollback

The system tracks all successfully created assignments across chunks:

- Each chunk's successful assignments are tracked in `allCreatedUserIds`
- If any chunk fails, all previously processed chunks are rolled back
- This ensures atomicity across the entire synchronous processing phase

### Error Handling

The synchronous sync implements comprehensive error handling:

- **Chunk-Level Errors**: If `updateAssignmentsForOrgChunkHandler` returns `success: false`, all previous chunks are rolled back and an error is thrown
- **User-Level Errors**: If assignment creation fails for any user within a chunk, that entire chunk is rolled back and an error is thrown
- **Rollback Errors**: If rollback itself fails, errors are logged but the original error is still propagated
- **Final Rollback**: A catch block in `createAssignments` ensures rollback is attempted even if the error occurs outside the chunk loop
- **Error Propagation**: Errors thrown from `createAssignments` are caught by the try-catch block in `upsertAdministrationHandler`. For new administrations, the error is re-thrown to prevent the function from returning successfully. For updates, the error is logged but not re-thrown, allowing the function to return successfully.

### Error Recovery

If synchronous sync fails for a **new administration**:

1. All created assignments are rolled back automatically via `rollbackAssignmentCreation`
2. The administration document is deleted via `rollbackAdministrationCreation`
3. The administration ID is removed from the creator's `adminData.administrationsCreated` array
4. The error is logged with full context (chunk index, user IDs, administration ID, creator UID)
5. The error is re-thrown, causing the `upsertAdministration` function to fail
6. The client receives an error message: "Failed to create assignment for all participants. Please try again."
7. The entire operation is atomic - either everything succeeds or everything is rolled back

If synchronous sync fails for an **existing administration update**:

1. All created assignments are rolled back automatically via `rollbackAssignmentCreation`
2. The error is logged but not re-thrown
3. The `upsertAdministration` function returns successfully (the administration document update remains)
4. The background Firestore trigger will process assignments asynchronously as a fallback
5. Users may experience a delay, but assignments will eventually appear via the background trigger

**Note**: For new administrations, the rollback is complete and atomic - both assignments and the administration document are removed. For updates, only assignments are rolled back since the administration document update is considered successful even if assignment sync fails.

## Performance Considerations

### Function Execution Time

- **All Assignments**: All chunks are processed synchronously before the function returns
- **Execution Time**: Scales linearly with the number of org chunks (each chunk processes up to 100 organizations)
- **Timeout Considerations**: Cloud Functions have a maximum timeout (typically 540 seconds for 2nd gen). For very large assignments, monitor execution time to ensure it stays within limits

### Transaction Limits

The implementation respects Firestore transaction limits:

- Maximum of `MAX_TRANSACTIONS` (100) documents per transaction
- Large user sets are processed in chunks across multiple transactions

## Testing

When testing this functionality:

1. **Verify Immediate Visibility**: Create an assignment and confirm it appears immediately on the home page
2. **Test Large Assignments**: Create assignments with many orgs to verify background processing continues
3. **Test Updates**: Edit existing assignments to verify synchronous updates work correctly
4. **Monitor Logs**: Check for synchronous sync completion logs and background trigger execution

## Future Improvements

Potential enhancements:

1. **Skip Background Processing**: Disable or skip the background trigger when all chunks have been processed synchronously to reduce unnecessary overhead
2. **Progress Tracking**: Add metadata to track which chunks have been processed synchronously (useful if we need to reintroduce chunk limits)
3. **Configurable Chunk Limits**: If timeout issues occur, make chunk processing limits configurable via environment variables
4. **Metrics**: Track synchronous processing performance and identify any timeout issues

## Related Files

- `functions/levante-admin/src/upsertAdministration.ts` - Main handler with synchronous sync and rollback logic
- `functions/levante-admin/src/assignments/sync-assignments.ts` - Assignment sync utilities with error handling
- `functions/levante-admin/src/assignments/assignment-utils.ts` - Contains `rollbackAssignmentCreation` and `rollbackAdministrationCreation` functions
- `functions/levante-admin/src/assignments/on-assignment-updates.ts` - Administration stats management
- `functions/levante-admin/src/administrations/sync-administrations.ts` - Background sync handlers
- `functions/levante-admin/src/index.ts` - Firestore trigger definitions

## Notes

- The background trigger (`syncAssignmentsOnAdministrationUpdate`) will still fire after document writes, but it is redundant since all chunks are already processed synchronously
- Duplicate processing is safe due to idempotent operations, but adds unnecessary overhead
- The synchronous processing uses the same underlying functions as the background trigger for consistency
- The helper functions (`createAssignments` and `updateAssignments`) are defined as private functions within the `upsertAdministration.ts` file
- For update operations, the previous administration data is fetched before the transaction to enable proper comparison of org changes
- The rollback mechanism ensures **complete atomicity** - if any participant fails to receive an assignment, the entire operation (including the administration document for new administrations) is rolled back
- Rollback happens at the chunk level - if any chunk fails, all previously processed chunks are rolled back
- The `updateAssignmentsForOrgChunkHandler` function also implements its own rollback for failed chunks, providing defense-in-depth
- Statistics are updated synchronously when adding new assignments (mode: "add") to ensure immediate visibility
- **All chunks are processed synchronously** - there is no limit on the number of chunks processed, ensuring complete assignment creation before the function returns
