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

The solution implements **synchronous assignment processing** within the `upsertAdministration` handler, ensuring that critical assignment operations complete before the function returns. This provides immediate visibility of assignments while maintaining the background trigger for eventual consistency.

## Implementation Details

### Architecture

The implementation follows a two-tier approach:

1. **Synchronous Processing (Primary)**: Processes the first 3 org chunks (up to ~300 organizations) immediately
2. **Background Processing (Secondary)**: The existing Firestore trigger continues to handle:
   - Remaining org chunks for large assignments
   - Eventual consistency
   - Edge cases and retries

### Code Structure

The synchronous sync logic is implemented as two helper functions within `upsertAdministration.ts`:

- `syncNewAdministrationAssignments` - Handles new administration creation
- `syncModifiedAdministrationAssignments` - Handles administration updates

These functions are called directly after the Firestore transaction completes, ensuring assignments are processed before the function returns to the client.

### Key Functions

#### `syncNewAdministrationAssignments`

Handles synchronous assignment creation for new administrations:

```typescript
const syncNewAdministrationAssignments = async (
  administrationId: string,
  administrationDocRef: DocumentReference,
  currData: IAdministration
)
```

**Process:**

1. Standardizes administration orgs using `standardizeAdministrationOrgs`
2. Chunks orgs into groups of 100
3. Processes the first 3 chunks synchronously using `updateAssignmentsForOrgChunkHandler`
4. Tracks all successfully created assignments for rollback if any chunk fails
5. Logs if additional chunks will be processed by the background trigger

#### `syncModifiedAdministrationAssignments`

Handles synchronous assignment updates for modified administrations:

```typescript
const syncModifiedAdministrationAssignments = async (
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
4. Processes the first 3 org chunks synchronously for updates

### Modified Flow

**Before:**

```
upsertAdministration → Transaction → Return
                                      ↓
                    Firestore Trigger (async) → Process Assignments
```

**After:**

```
upsertAdministration → Transaction → Sync Assignments (sync) → Return
                                      ↓
                    Firestore Trigger (async) → Process Remaining Chunks
```

### Implementation Details

The synchronous sync happens immediately after the transaction commits:

1. The administration document is fetched from Firestore (to ensure server timestamps are populated)
2. Based on whether it's a create or update operation, the appropriate sync function is called
3. The sync function processes org chunks synchronously
4. The function returns, allowing the client to see the assignment immediately
5. The background trigger continues processing any remaining chunks asynchronously

### Integration with Background Trigger

The background Firestore trigger (`syncAssignmentsOnAdministrationUpdate`) continues to operate:

- **Idempotent Operations**: All assignment operations are idempotent, so duplicate processing is safe
- **Large Scale**: For assignments with more than 3 org chunks, the background trigger processes remaining chunks
- **Resilience**: Provides backup processing if synchronous processing encounters errors
- **Eventual Consistency**: Ensures all assignments are eventually processed correctly

## Configuration

### Synchronous Processing Limits

The implementation processes the first **3 org chunks** synchronously, where each chunk contains up to **100 organizations**. This balances:

- **Immediate Visibility**: Users see assignments immediately for most common scenarios
- **Function Timeout**: Prevents Cloud Functions from timing out on very large assignments
- **Performance**: Keeps response times reasonable

These limits can be adjusted by modifying the `maxChunksToProcessSync` constant in:

- `syncNewAdministrationAssignments`
- `syncModifiedAdministrationAssignments`

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
- **Final Rollback**: A catch block in `syncNewAdministrationAssignments` ensures rollback is attempted even if the error occurs outside the chunk loop
- **Error Propagation**: Errors thrown from `syncNewAdministrationAssignments` are caught by the try-catch block in `upsertAdministrationHandler`. For new administrations, the error is re-thrown to prevent the function from returning successfully. For updates, the error is logged but not re-thrown, allowing the function to return successfully.

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

- **Small Assignments** (≤3 chunks): Fully processed synchronously
- **Large Assignments** (>3 chunks): First 3 chunks processed synchronously, remainder processed in background

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

1. **Configurable Chunk Limits**: Make `maxChunksToProcessSync` configurable via environment variables
2. **Progress Tracking**: Add metadata to track which chunks have been processed synchronously
3. **Skip Background Processing**: Optionally skip background trigger for fully-synced assignments
4. **Metrics**: Track synchronous vs. background processing ratios

## Related Files

- `functions/levante-admin/src/upsertAdministration.ts` - Main handler with synchronous sync and rollback logic
- `functions/levante-admin/src/assignments/sync-assignments.ts` - Assignment sync utilities with error handling
- `functions/levante-admin/src/assignments/assignment-utils.ts` - Contains `rollbackAssignmentCreation` and `rollbackAdministrationCreation` functions
- `functions/levante-admin/src/assignments/on-assignment-updates.ts` - Administration stats management
- `functions/levante-admin/src/administrations/sync-administrations.ts` - Background sync handlers
- `functions/levante-admin/src/index.ts` - Firestore trigger definitions

## Notes

- The background trigger (`syncAssignmentsOnAdministrationUpdate`) will still fire after document writes
- Duplicate processing is safe due to idempotent operations
- The synchronous processing uses the same underlying functions as the background trigger for consistency
- The helper functions (`syncNewAdministrationAssignments` and `syncModifiedAdministrationAssignments`) are defined as private functions within the `upsertAdministration.ts` file
- For update operations, the previous administration data is fetched before the transaction to enable proper comparison of org changes
