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
4. Logs if additional chunks will be processed by the background trigger

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

## Error Handling

The synchronous sync is wrapped in a try-catch block that:

- Logs errors without failing the main `upsertAdministration` operation
- Allows the function to return successfully even if sync fails
- Relies on the background trigger as a fallback for error recovery

This ensures that assignment creation/updates are not blocked by sync errors. Even if the synchronous sync encounters an error, the administration document is still created/updated successfully, and the background trigger will process the assignments asynchronously.

### Error Recovery

If synchronous sync fails:
1. The error is logged with full context
2. The `upsertAdministration` function still returns successfully
3. The background Firestore trigger will process all assignments
4. Users may experience a slight delay, but assignments will appear eventually

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

- `functions/levante-admin/src/upsertAdministration.ts` - Main handler with synchronous sync
- `functions/levante-admin/src/assignments/sync-assignments.ts` - Assignment sync utilities
- `functions/levante-admin/src/administrations/sync-administrations.ts` - Background sync handlers
- `functions/levante-admin/src/index.ts` - Firestore trigger definitions

## Notes

- The background trigger (`syncAssignmentsOnAdministrationUpdate`) will still fire after document writes
- Duplicate processing is safe due to idempotent operations
- The synchronous processing uses the same underlying functions as the background trigger for consistency
- The helper functions (`syncNewAdministrationAssignments` and `syncModifiedAdministrationAssignments`) are defined as private functions within the `upsertAdministration.ts` file
- For update operations, the previous administration data is fetched before the transaction to enable proper comparison of org changes

